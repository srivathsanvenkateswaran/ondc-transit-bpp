package transport

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"errors"
	"sync"
	"time"
)

var ErrClosed = errors.New("transport closed")

type memoryEnvelope struct {
	id, topic string
	data      []byte
	attempts  int
}

type MemoryTransport struct {
	mu          sync.RWMutex
	subs        map[string]map[*memorySubscription]struct{}
	dlq         map[string][][]byte
	maxAttempts int
	backoff     time.Duration
	closed      bool
}

type memorySubscription struct {
	parent  *MemoryTransport
	topic   string
	handler Handler
	ctx     context.Context
	closed  chan struct{}
	once    sync.Once
}

type memoryMessage struct {
	env  memoryEnvelope
	sub  *memorySubscription
	once sync.Once
	done chan struct{}
	nack error
}

func NewMemoryTransport(maxAttempts int, backoff time.Duration) *MemoryTransport {
	if maxAttempts < 1 {
		maxAttempts = 1
	}
	return &MemoryTransport{subs: make(map[string]map[*memorySubscription]struct{}), dlq: make(map[string][][]byte), maxAttempts: maxAttempts, backoff: backoff}
}

func (t *MemoryTransport) Publish(ctx context.Context, topic string, data []byte) error {
	t.mu.RLock()
	if t.closed {
		t.mu.RUnlock()
		return ErrClosed
	}
	subs := make([]*memorySubscription, 0, len(t.subs[topic]))
	for sub := range t.subs[topic] {
		subs = append(subs, sub)
	}
	t.mu.RUnlock()
	if len(subs) == 0 {
		return nil
	}
	b := make([]byte, 16)
	_, _ = rand.Read(b)
	env := memoryEnvelope{id: hex.EncodeToString(b), topic: topic, data: append([]byte(nil), data...)}
	select {
	case <-ctx.Done():
		return ctx.Err()
	default:
	}
	go t.deliver(subs[0], env)
	return nil
}

func (t *MemoryTransport) deliver(sub *memorySubscription, env memoryEnvelope) {
	for env.attempts < t.maxAttempts {
		env.attempts++
		msg := &memoryMessage{env: env, sub: sub, done: make(chan struct{})}
		sub.handler(sub.ctx, msg)
		select {
		case <-msg.done:
			if msg.nack == nil {
				return
			}
		case <-sub.ctx.Done():
			return
		case <-sub.closed:
			return
		}
		if t.backoff > 0 {
			time.Sleep(t.backoff * time.Duration(env.attempts))
		}
	}
	t.mu.Lock()
	t.dlq[env.topic] = append(t.dlq[env.topic], append([]byte(nil), env.data...))
	t.mu.Unlock()
}

func (t *MemoryTransport) Subscribe(ctx context.Context, topic string, handler Handler) (Subscription, error) {
	if topic == "" || handler == nil {
		return nil, errors.New("topic and handler are required")
	}
	s := &memorySubscription{parent: t, topic: topic, handler: handler, ctx: ctx, closed: make(chan struct{})}
	t.mu.Lock()
	defer t.mu.Unlock()
	if t.closed {
		return nil, ErrClosed
	}
	if t.subs[topic] == nil {
		t.subs[topic] = make(map[*memorySubscription]struct{})
	}
	t.subs[topic][s] = struct{}{}
	return s, nil
}

func (t *MemoryTransport) DeadLetters(topic string) [][]byte {
	t.mu.RLock()
	defer t.mu.RUnlock()
	return clone(t.dlq[topic])
}
func (t *MemoryTransport) Ready(context.Context) error {
	t.mu.RLock()
	defer t.mu.RUnlock()
	if t.closed {
		return ErrClosed
	}
	return nil
}
func (t *MemoryTransport) Close() error {
	t.mu.Lock()
	defer t.mu.Unlock()
	if t.closed {
		return nil
	}
	t.closed = true
	for _, set := range t.subs {
		for s := range set {
			s.once.Do(func() { close(s.closed) })
		}
	}
	return nil
}
func (s *memorySubscription) Close() error {
	s.once.Do(func() { close(s.closed); s.parent.mu.Lock(); delete(s.parent.subs[s.topic], s); s.parent.mu.Unlock() })
	return nil
}
func (m *memoryMessage) ID() string    { return m.env.id }
func (m *memoryMessage) Data() []byte  { return append([]byte(nil), m.env.data...) }
func (m *memoryMessage) Attempts() int { return m.env.attempts }
func (m *memoryMessage) Ack() error    { m.once.Do(func() { close(m.done) }); return nil }
func (m *memoryMessage) Nack(err error) error {
	m.once.Do(func() { m.nack = err; close(m.done) })
	return nil
}
func clone(in [][]byte) [][]byte {
	out := make([][]byte, len(in))
	for i := range in {
		out[i] = append([]byte(nil), in[i]...)
	}
	return out
}
