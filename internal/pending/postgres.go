package pending

import (
	"context"
	"errors"
	"fmt"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

type PostgresStore struct {
	pool *pgxpool.Pool
	poll time.Duration
}

func NewPostgresStore(ctx context.Context, dsn string) (*PostgresStore, error) {
	if dsn == "" {
		return nil, errors.New("Postgres DSN is required")
	}
	pool, err := pgxpool.New(ctx, dsn)
	if err != nil {
		return nil, err
	}
	s := &PostgresStore{pool: pool, poll: 20 * time.Millisecond}
	if err := s.migrate(ctx); err != nil {
		pool.Close()
		return nil, err
	}
	return s, nil
}

func (s *PostgresStore) migrate(ctx context.Context) error {
	_, err := s.pool.Exec(ctx, `
CREATE TABLE IF NOT EXISTS network_pending (
  correlation_id text PRIMARY KEY,
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS network_callbacks (
  correlation_id text NOT NULL REFERENCES network_pending(correlation_id) ON DELETE CASCADE,
  sequence bigint GENERATED ALWAYS AS IDENTITY,
  payload bytea NOT NULL,
  PRIMARY KEY (correlation_id, sequence)
);
CREATE INDEX IF NOT EXISTS network_pending_expiry ON network_pending(expires_at);`)
	return err
}

func (s *PostgresStore) Claim(ctx context.Context, id string, ttl time.Duration) error {
	if id == "" || ttl <= 0 {
		return ErrExpired
	}
	tag, err := s.pool.Exec(ctx, `INSERT INTO network_pending(correlation_id, expires_at) VALUES ($1, now() + $2::interval) ON CONFLICT DO NOTHING`, id, durationInterval(ttl))
	if err != nil {
		return err
	}
	if tag.RowsAffected() == 0 {
		return ErrClaimed
	}
	return nil
}

func (s *PostgresStore) Append(ctx context.Context, id string, callback []byte) error {
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx)
	var expired bool
	err = tx.QueryRow(ctx, `SELECT expires_at <= now() FROM network_pending WHERE correlation_id=$1 FOR UPDATE`, id).Scan(&expired)
	if errors.Is(err, pgx.ErrNoRows) {
		return ErrNotFound
	}
	if err != nil {
		return err
	}
	if expired {
		_, _ = tx.Exec(ctx, `DELETE FROM network_pending WHERE correlation_id=$1`, id)
		_ = tx.Commit(ctx)
		return ErrExpired
	}
	if _, err = tx.Exec(ctx, `INSERT INTO network_callbacks(correlation_id,payload) VALUES($1,$2)`, id, callback); err != nil {
		return err
	}
	return tx.Commit(ctx)
}

func (s *PostgresStore) Await(ctx context.Context, id string, count int) ([][]byte, error) {
	if count < 1 {
		return nil, ErrNotFound
	}
	for {
		var expires time.Time
		err := s.pool.QueryRow(ctx, `SELECT expires_at FROM network_pending WHERE correlation_id=$1`, id).Scan(&expires)
		if errors.Is(err, pgx.ErrNoRows) {
			return nil, ErrNotFound
		}
		if err != nil {
			return nil, err
		}
		rows, err := s.pool.Query(ctx, `SELECT payload FROM network_callbacks WHERE correlation_id=$1 ORDER BY sequence`, id)
		if err != nil {
			return nil, err
		}
		var out [][]byte
		for rows.Next() {
			var payload []byte
			if err := rows.Scan(&payload); err != nil {
				rows.Close()
				return nil, err
			}
			out = append(out, payload)
		}
		err = rows.Err()
		rows.Close()
		if err != nil {
			return nil, err
		}
		if len(out) >= count {
			return out, nil
		}
		if !time.Now().Before(expires) {
			if len(out) > 0 {
				return out, nil
			}
			return nil, ErrExpired
		}
		wait := time.Until(expires)
		if wait > s.poll {
			wait = s.poll
		}
		timer := time.NewTimer(wait)
		select {
		case <-ctx.Done():
			if !timer.Stop() {
				<-timer.C
			}
			return nil, ctx.Err()
		case <-timer.C:
		}
	}
}

func (s *PostgresStore) Release(ctx context.Context, id string) error {
	tag, err := s.pool.Exec(ctx, `DELETE FROM network_pending WHERE correlation_id=$1`, id)
	if err != nil {
		return err
	}
	if tag.RowsAffected() == 0 {
		return ErrNotFound
	}
	return nil
}
func (s *PostgresStore) Ready(ctx context.Context) error { return s.pool.Ping(ctx) }
func (s *PostgresStore) Close() error                    { s.pool.Close(); return nil }
func durationInterval(d time.Duration) string            { return fmt.Sprintf("%f seconds", d.Seconds()) }
