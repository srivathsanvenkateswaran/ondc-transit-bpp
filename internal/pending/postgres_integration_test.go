package pending

import (
	"context"
	"os"
	"testing"
)

func TestPostgresStoreSuite(t *testing.T) {
	dsn := os.Getenv("POSTGRES_TEST_DSN")
	if dsn == "" {
		t.Skip("POSTGRES_TEST_DSN is not set")
	}
	runStoreSuite(t, func(t *testing.T) Store {
		s, err := NewPostgresStore(context.Background(), dsn)
		if err != nil {
			t.Fatal(err)
		}
		return s
	})
}
