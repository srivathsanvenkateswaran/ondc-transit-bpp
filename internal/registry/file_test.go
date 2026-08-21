package registry

import (
	"context"
	"errors"
	"path/filepath"
	"testing"
	"time"
)

func TestFileStorePersistsRotationAndAudit(t *testing.T) {
	path := filepath.Join(t.TempDir(), "registry.json")
	s, err := NewFileStore(path)
	if err != nil {
		t.Fatal(err)
	}
	now := time.Now().UTC()
	first := Subscriber{ID: "seller.test", URI: "http://seller", Type: "BPP", Domain: "ONDC:TRV11", KeyID: "key-1", PublicKey: "aaa", ValidFrom: now.Add(-time.Hour), ValidTo: now.Add(time.Hour), Status: "SUBSCRIBED"}
	second := first
	second.KeyID = "key-2"
	second.PublicKey = "bbb"
	if err := s.Put(context.Background(), "operator", first); err != nil {
		t.Fatal(err)
	}
	if err := s.Put(context.Background(), "operator", second); err != nil {
		t.Fatal(err)
	}
	reopened, err := NewFileStore(path)
	if err != nil {
		t.Fatal(err)
	}
	got, err := reopened.Get(context.Background(), "seller.test", "key-1", now)
	if err != nil {
		t.Fatal(err)
	}
	if got.PublicKey != "aaa" {
		t.Fatalf("public key = %q", got.PublicKey)
	}
	history, _ := reopened.History(context.Background(), "seller.test")
	if len(history) != 2 {
		t.Fatalf("history = %d", len(history))
	}
	audit, _ := reopened.Audit(context.Background(), 10)
	if len(audit) != 2 {
		t.Fatalf("audit = %d", len(audit))
	}
	lookup, _ := reopened.Lookup(context.Background(), "ONDC:TRV11", "BPP", now)
	if len(lookup) != 1 || lookup[0].KeyID != "key-2" {
		t.Fatalf("lookup = %#v", lookup)
	}
	if _, err := reopened.Get(context.Background(), "seller.test", "missing", now); !errors.Is(err, ErrNotFound) {
		t.Fatalf("error = %v", err)
	}
}
