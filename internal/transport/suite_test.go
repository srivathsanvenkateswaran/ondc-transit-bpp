package transport

import (
	"context"
	"errors"
	"testing"
	"time"
)

func TestMemoryTransportAtLeastOnce(t *testing.T) {
	tr := NewMemoryTransport(3, time.Millisecond)
	defer tr.Close()
	done := make(chan int, 1)
	_, err := tr.Subscribe(context.Background(), "work", func(_ context.Context, msg Message) {
		if msg.Attempts() < 2 {
			_ = msg.Nack(errors.New("retry"))
			return
		}
		done <- msg.Attempts()
		_ = msg.Ack()
	})
	if err != nil {
		t.Fatal(err)
	}
	if err := tr.Publish(context.Background(), "work", []byte("payload")); err != nil {
		t.Fatal(err)
	}
	select {
	case attempts := <-done:
		if attempts != 2 {
			t.Fatalf("attempts = %d", attempts)
		}
	case <-time.After(time.Second):
		t.Fatal("delivery timed out")
	}
}

func TestMemoryTransportDeadLetter(t *testing.T) {
	tr := NewMemoryTransport(2, time.Millisecond)
	defer tr.Close()
	_, err := tr.Subscribe(context.Background(), "work", func(_ context.Context, msg Message) { _ = msg.Nack(errors.New("no")) })
	if err != nil {
		t.Fatal(err)
	}
	if err := tr.Publish(context.Background(), "work", []byte("lost")); err != nil {
		t.Fatal(err)
	}
	deadline := time.Now().Add(time.Second)
	for len(tr.DeadLetters("work")) == 0 && time.Now().Before(deadline) {
		time.Sleep(time.Millisecond)
	}
	if got := tr.DeadLetters("work"); len(got) != 1 || string(got[0]) != "lost" {
		t.Fatalf("dlq = %q", got)
	}
}
