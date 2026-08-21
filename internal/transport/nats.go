package transport

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"strings"
	"sync"
	"time"

	"github.com/nats-io/nats.go"
)

type NATSTransport struct {
	nc          *nats.Conn
	js          nats.JetStreamContext
	stream      string
	prefix      string
	maxAttempts int
	ackWait     time.Duration
	mu          sync.Mutex
	subs        []*nats.Subscription
}

type natsSubscription struct{ sub *nats.Subscription }
type natsMessage struct {
	msg         *nats.Msg
	js          nats.JetStreamContext
	dlq         string
	attempts    int
	maxAttempts int
	once        sync.Once
	result      error
}

func NewNATSTransport(url, stream, prefix string, maxAttempts int, ackWait time.Duration) (*NATSTransport, error) {
	if url == "" {
		return nil, errors.New("NATS URL is required")
	}
	if stream == "" {
		stream = "ONDC_NETWORK"
	}
	if prefix == "" {
		prefix = "ondc"
	}
	if maxAttempts < 1 {
		maxAttempts = 5
	}
	if ackWait <= 0 {
		ackWait = 30 * time.Second
	}
	nc, err := nats.Connect(url, nats.Name("ondc-go-network"), nats.MaxReconnects(-1), nats.ReconnectWait(time.Second))
	if err != nil {
		return nil, err
	}
	js, err := nc.JetStream(nats.PublishAsyncMaxPending(256))
	if err != nil {
		nc.Close()
		return nil, err
	}
	_, err = js.AddStream(&nats.StreamConfig{Name: stream, Subjects: []string{prefix + ".>"}, Storage: nats.FileStorage, Retention: nats.LimitsPolicy, Discard: nats.DiscardOld, MaxAge: 7 * 24 * time.Hour, Replicas: 1})
	if err != nil && !errors.Is(err, nats.ErrStreamNameAlreadyInUse) {
		if _, infoErr := js.StreamInfo(stream); infoErr != nil {
			nc.Close()
			return nil, err
		}
	}
	return &NATSTransport{nc: nc, js: js, stream: stream, prefix: prefix, maxAttempts: maxAttempts, ackWait: ackWait}, nil
}

func (t *NATSTransport) subject(topic string) (string, error) {
	if topic == "" || strings.ContainsAny(topic, "*> ") {
		return "", errors.New("invalid topic")
	}
	return t.prefix + "." + topic, nil
}
func (t *NATSTransport) Publish(ctx context.Context, topic string, data []byte) error {
	subject, err := t.subject(topic)
	if err != nil {
		return err
	}
	msg := nats.NewMsg(subject)
	msg.Data = append([]byte(nil), data...)
	_, err = t.js.PublishMsg(msg, nats.Context(ctx))
	return err
}
func (t *NATSTransport) Subscribe(ctx context.Context, topic string, handler Handler) (Subscription, error) {
	subject, err := t.subject(topic)
	if err != nil {
		return nil, err
	}
	if handler == nil {
		return nil, errors.New("handler is required")
	}
	hash := sha256.Sum256([]byte(topic))
	durable := "worker_" + hex.EncodeToString(hash[:8])
	dlq := subject + ".DLQ"
	sub, err := t.js.QueueSubscribe(subject, durable, func(msg *nats.Msg) {
		meta, e := msg.Metadata()
		attempts := 1
		if e == nil {
			attempts = int(meta.NumDelivered)
		}
		handler(ctx, &natsMessage{msg: msg, js: t.js, dlq: dlq, attempts: attempts, maxAttempts: t.maxAttempts})
	}, nats.Durable(durable), nats.ManualAck(), nats.AckWait(t.ackWait), nats.MaxDeliver(t.maxAttempts), nats.BindStream(t.stream))
	if err != nil {
		return nil, err
	}
	t.mu.Lock()
	t.subs = append(t.subs, sub)
	t.mu.Unlock()
	return &natsSubscription{sub: sub}, nil
}
func (t *NATSTransport) Ready(ctx context.Context) error {
	if !t.nc.IsConnected() {
		return errors.New("NATS is disconnected")
	}
	_, err := t.js.StreamInfo(t.stream, nats.Context(ctx))
	return err
}
func (t *NATSTransport) Close() error {
	t.mu.Lock()
	for _, s := range t.subs {
		_ = s.Drain()
	}
	t.subs = nil
	t.mu.Unlock()
	if err := t.nc.Drain(); err != nil {
		t.nc.Close()
		return err
	}
	return nil
}
func (s *natsSubscription) Close() error { return s.sub.Drain() }
func (m *natsMessage) ID() string        { return m.msg.Header.Get(nats.MsgIdHdr) }
func (m *natsMessage) Data() []byte      { return append([]byte(nil), m.msg.Data...) }
func (m *natsMessage) Attempts() int     { return m.attempts }
func (m *natsMessage) Ack() error        { m.once.Do(func() { m.result = m.msg.Ack() }); return m.result }
func (m *natsMessage) Nack(cause error) error {
	m.once.Do(func() {
		if m.attempts >= m.maxAttempts {
			h := nats.Header{}
			h.Set("Nats-Original-Subject", m.msg.Subject)
			h.Set("Nats-Failure", fmt.Sprint(cause))
			_, err := m.js.PublishMsg(&nats.Msg{Subject: m.dlq, Header: h, Data: m.msg.Data})
			if err != nil {
				m.result = err
				return
			}
			m.result = m.msg.Term()
			return
		}
		m.result = m.msg.Nak()
	})
	return m.result
}
