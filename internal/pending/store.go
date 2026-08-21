package pending

import (
	"context"
	"errors"
	"time"
)

var (
	ErrClaimed  = errors.New("correlation id already claimed")
	ErrNotFound = errors.New("correlation id not found")
	ErrExpired  = errors.New("correlation id expired")
)

type Store interface {
	Claim(context.Context, string, time.Duration) error
	Append(context.Context, string, []byte) error
	Await(context.Context, string, int) ([][]byte, error)
	Release(context.Context, string) error
	Ready(context.Context) error
	Close() error
}
