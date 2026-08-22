package registry

import (
	"context"
	"encoding/json"
	"errors"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

type PostgresStore struct{ pool *pgxpool.Pool }

func NewPostgresStore(ctx context.Context, dsn string) (*PostgresStore, error) {
	if dsn == "" {
		return nil, errors.New("Postgres DSN is required")
	}
	p, err := pgxpool.New(ctx, dsn)
	if err != nil {
		return nil, err
	}
	s := &PostgresStore{pool: p}
	if err = s.migrate(ctx); err != nil {
		p.Close()
		return nil, err
	}
	return s, nil
}
func (s *PostgresStore) migrate(ctx context.Context) error {
	_, err := s.pool.Exec(ctx, `
CREATE TABLE IF NOT EXISTS network_subscribers (
  version bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  subscriber_id text NOT NULL, unique_key_id text NOT NULL,
  subscriber_url text NOT NULL, participant_type text NOT NULL,
  domain text NOT NULL, signing_public_key text NOT NULL,
  valid_from timestamptz NOT NULL, valid_until timestamptz NOT NULL,
  status text NOT NULL, created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS network_subscriber_lookup ON network_subscribers(subscriber_id,unique_key_id,valid_from,valid_until);
CREATE TABLE IF NOT EXISTS network_registry_audit (
  sequence bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  at timestamptz NOT NULL DEFAULT now(), actor text NOT NULL,
  operation text NOT NULL, before_value jsonb, after_value jsonb
);`)
	return err
}
func (s *PostgresStore) Put(ctx context.Context, actor string, sub Subscriber) error {
	if sub.ID == "" || sub.KeyID == "" || sub.URI == "" || sub.PublicKey == "" || !sub.ValidTo.After(sub.ValidFrom) {
		return errors.New("invalid subscriber")
	}
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx)
	var beforeJSON []byte
	var before Subscriber
	err = tx.QueryRow(ctx, `SELECT subscriber_id,subscriber_url,participant_type,domain,unique_key_id,signing_public_key,valid_from,valid_until,status FROM network_subscribers WHERE subscriber_id=$1 AND unique_key_id=$2 ORDER BY version DESC LIMIT 1`, sub.ID, sub.KeyID).Scan(&before.ID, &before.URI, &before.Type, &before.Domain, &before.KeyID, &before.PublicKey, &before.ValidFrom, &before.ValidTo, &before.Status)
	if err == nil {
		beforeJSON, _ = json.Marshal(before)
	} else if !errors.Is(err, pgx.ErrNoRows) {
		return err
	}
	afterJSON, _ := json.Marshal(sub)
	_, err = tx.Exec(ctx, `INSERT INTO network_subscribers(subscriber_id,unique_key_id,subscriber_url,participant_type,domain,signing_public_key,valid_from,valid_until,status) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)`, sub.ID, sub.KeyID, sub.URI, sub.Type, sub.Domain, sub.PublicKey, sub.ValidFrom, sub.ValidTo, sub.Status)
	if err != nil {
		return err
	}
	_, err = tx.Exec(ctx, `INSERT INTO network_registry_audit(actor,operation,before_value,after_value) VALUES($1,'put',$2,$3)`, actor, nullableJSON(beforeJSON), afterJSON)
	if err != nil {
		return err
	}
	return tx.Commit(ctx)
}
func (s *PostgresStore) Get(ctx context.Context, id, keyID string, at time.Time) (Subscriber, error) {
	var v Subscriber
	err := s.pool.QueryRow(ctx, `SELECT subscriber_id,subscriber_url,participant_type,domain,unique_key_id,signing_public_key,valid_from,valid_until,status FROM network_subscribers WHERE subscriber_id=$1 AND unique_key_id=$2 AND valid_from<=$3 AND valid_until>$3 AND status='SUBSCRIBED' ORDER BY version DESC LIMIT 1`, id, keyID, at).Scan(&v.ID, &v.URI, &v.Type, &v.Domain, &v.KeyID, &v.PublicKey, &v.ValidFrom, &v.ValidTo, &v.Status)
	if errors.Is(err, pgx.ErrNoRows) {
		return Subscriber{}, ErrNotFound
	}
	return v, err
}
func (s *PostgresStore) Lookup(ctx context.Context, domain, typ string, at time.Time) ([]Subscriber, error) {
	rows, err := s.pool.Query(ctx, `SELECT DISTINCT ON (subscriber_id) subscriber_id,subscriber_url,participant_type,domain,unique_key_id,signing_public_key,valid_from,valid_until,status FROM network_subscribers WHERE domain=$1 AND participant_type=$2 AND valid_from<=$3 AND valid_until>$3 AND status='SUBSCRIBED' ORDER BY subscriber_id,version DESC`, domain, typ, at)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	return scanSubscribers(rows)
}
func (s *PostgresStore) History(ctx context.Context, id string) ([]Subscriber, error) {
	rows, err := s.pool.Query(ctx, `SELECT subscriber_id,subscriber_url,participant_type,domain,unique_key_id,signing_public_key,valid_from,valid_until,status FROM network_subscribers WHERE subscriber_id=$1 ORDER BY version`, id)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	return scanSubscribers(rows)
}
func (s *PostgresStore) Audit(ctx context.Context, limit int) ([]AuditEvent, error) {
	if limit <= 0 {
		limit = 100
	}
	rows, err := s.pool.Query(ctx, `SELECT at,actor,operation,before_value,after_value FROM network_registry_audit ORDER BY sequence DESC LIMIT $1`, limit)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []AuditEvent
	for rows.Next() {
		var e AuditEvent
		var before, after []byte
		if err := rows.Scan(&e.At, &e.Actor, &e.Operation, &before, &after); err != nil {
			return nil, err
		}
		if len(before) > 0 {
			e.Before = &Subscriber{}
			if err := json.Unmarshal(before, e.Before); err != nil {
				return nil, err
			}
		}
		if len(after) > 0 {
			e.After = &Subscriber{}
			if err := json.Unmarshal(after, e.After); err != nil {
				return nil, err
			}
		}
		out = append(out, e)
	}
	return out, rows.Err()
}
func (s *PostgresStore) Ready(ctx context.Context) error { return s.pool.Ping(ctx) }
func (s *PostgresStore) Close() error                    { s.pool.Close(); return nil }

type rowsScanner interface {
	Next() bool
	Scan(...any) error
	Err() error
}

func scanSubscribers(rows rowsScanner) ([]Subscriber, error) {
	var out []Subscriber
	for rows.Next() {
		var v Subscriber
		if err := rows.Scan(&v.ID, &v.URI, &v.Type, &v.Domain, &v.KeyID, &v.PublicKey, &v.ValidFrom, &v.ValidTo, &v.Status); err != nil {
			return nil, err
		}
		out = append(out, v)
	}
	return out, rows.Err()
}
func nullableJSON(v []byte) any {
	if len(v) == 0 {
		return nil
	}
	return v
}
