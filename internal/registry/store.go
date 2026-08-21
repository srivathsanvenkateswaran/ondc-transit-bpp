package registry

import (
	"context"
	"errors"
	"time"
)

var ErrNotFound = errors.New("subscriber key not found")

type Subscriber struct {
	ID        string    `json:"subscriber_id"`
	URI       string    `json:"subscriber_url"`
	Type      string    `json:"type"`
	Domain    string    `json:"domain"`
	KeyID     string    `json:"unique_key_id"`
	PublicKey string    `json:"signing_public_key"`
	ValidFrom time.Time `json:"valid_from"`
	ValidTo   time.Time `json:"valid_until"`
	Status    string    `json:"status"`
}

type AuditEvent struct {
	At        time.Time   `json:"at"`
	Actor     string      `json:"actor"`
	Operation string      `json:"operation"`
	Before    *Subscriber `json:"before,omitempty"`
	After     *Subscriber `json:"after,omitempty"`
}

type Store interface {
	Put(context.Context, string, Subscriber) error
	Get(context.Context, string, string, time.Time) (Subscriber, error)
	Lookup(context.Context, string, string, time.Time) ([]Subscriber, error)
	History(context.Context, string) ([]Subscriber, error)
	Audit(context.Context, int) ([]AuditEvent, error)
	Ready(context.Context) error
	Close() error
}
