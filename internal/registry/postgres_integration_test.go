package registry

import (
	"context"
	"os"
	"testing"
	"time"
)

func TestPostgresRegistryRotation(t *testing.T) {
	dsn := os.Getenv("POSTGRES_TEST_DSN")
	if dsn == "" {
		t.Skip("POSTGRES_TEST_DSN is not set")
	}
	s, err := NewPostgresStore(context.Background(), dsn)
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()
	now := time.Now().UTC()
	id := "seller-" + now.Format("150405.000000")
	v := Subscriber{ID: id, URI: "http://seller", Type: "BPP", Domain: "ONDC:TRV11", KeyID: "key-1", PublicKey: "one", ValidFrom: now.Add(-time.Minute), ValidTo: now.Add(time.Hour), Status: "SUBSCRIBED"}
	if err := s.Put(context.Background(), "test", v); err != nil {
		t.Fatal(err)
	}
	v.PublicKey = "two"
	if err := s.Put(context.Background(), "test", v); err != nil {
		t.Fatal(err)
	}
	history, err := s.History(context.Background(), id)
	if err != nil {
		t.Fatal(err)
	}
	if len(history) != 2 {
		t.Fatalf("history = %d", len(history))
	}
}
