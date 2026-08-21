package transport

import "context"

type Message interface {
	ID() string
	Data() []byte
	Attempts() int
	Ack() error
	Nack(error) error
}

type Handler func(context.Context, Message)

type Subscription interface{ Close() error }

type Transport interface {
	Publish(context.Context, string, []byte) error
	Subscribe(context.Context, string, Handler) (Subscription, error)
	Ready(context.Context) error
	Close() error
}
