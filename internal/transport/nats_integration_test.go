package transport

import (
	"context"
	"os"
	"testing"
	"time"
)

func TestNATSSurvivesConsumerRestart(t *testing.T) {
	url := os.Getenv("NATS_TEST_URL")
	if url == "" {
		t.Skip("NATS_TEST_URL is not set")
	}
	stream := "RESTART_" + time.Now().Format("150405000")
	producer, err := NewNATSTransport(url, stream, "restart", 3, time.Second)
	if err != nil {
		t.Fatal(err)
	}
	if err := producer.Publish(context.Background(), "work", []byte("in-flight")); err != nil {
		t.Fatal(err)
	}
	if err := producer.Close(); err != nil {
		t.Fatal(err)
	}

	consumer, err := NewNATSTransport(url, stream, "restart", 3, time.Second)
	if err != nil {
		t.Fatal(err)
	}
	defer consumer.Close()
	done := make(chan string, 1)
	_, err = consumer.Subscribe(context.Background(), "work", func(_ context.Context, msg Message) { done <- string(msg.Data()); _ = msg.Ack() })
	if err != nil {
		t.Fatal(err)
	}
	select {
	case got := <-done:
		if got != "in-flight" {
			t.Fatalf("payload = %q", got)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("durable work was lost across restart")
	}
}
