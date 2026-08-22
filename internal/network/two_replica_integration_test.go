package network

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"testing"
	"time"

	"github.com/gokul/ondc-transit-bpp/go-network/internal/auth"
	"github.com/gokul/ondc-transit-bpp/go-network/internal/pending"
	"github.com/gokul/ondc-transit-bpp/go-network/internal/registry"
	"github.com/gokul/ondc-transit-bpp/go-network/internal/transport"
)

func TestMemoryPendingStoresAreReplicaLocal(t *testing.T) {
	instanceA := pending.NewMemoryStore()
	instanceB := pending.NewMemoryStore()
	defer instanceA.Close()
	defer instanceB.Close()

	ctx := context.Background()
	if err := instanceA.Claim(ctx, "transaction|message|on_search", time.Second); err != nil {
		t.Fatal(err)
	}
	err := instanceB.Append(ctx, "transaction|message|on_search", []byte(`{"callback":1}`))
	if !errors.Is(err, pending.ErrNotFound) {
		t.Fatalf("second in-memory replica append error = %v, want %v", err, pending.ErrNotFound)
	}
}

func TestTwoReplicasCompleteSearchThroughSharedPostgres(t *testing.T) {
	dsn := os.Getenv("POSTGRES_TEST_DSN")
	if dsn == "" {
		t.Skip("POSTGRES_TEST_DSN is not set")
	}

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	storeA, err := pending.NewPostgresStore(ctx, dsn)
	if err != nil {
		t.Fatal(err)
	}
	defer storeA.Close()
	storeB, err := pending.NewPostgresStore(ctx, dsn)
	if err != nil {
		t.Fatal(err)
	}
	defer storeB.Close()

	reg, err := registry.NewFileStore(t.TempDir() + "/registry.json")
	if err != nil {
		t.Fatal(err)
	}
	bap := testIdentity(t, "bap.replica.test", "bap-key")
	gateway := testIdentity(t, "gateway.replica.test", "gateway-key")
	bmtc := testIdentity(t, "bmtc.replica.test", "bmtc-key")
	bmrcl := testIdentity(t, "bmrcl.replica.test", "bmrcl-key")
	for _, participant := range []struct {
		identity Identity
		typ      string
	}{{bap, "BAP"}, {gateway, "BG"}, {bmtc, "BPP"}, {bmrcl, "BPP"}} {
		seed(t, reg, participant.identity, participant.typ)
	}

	transportA := transport.NewMemoryTransport(3, time.Millisecond)
	transportB := transport.NewMemoryTransport(3, time.Millisecond)
	defer transportA.Close()
	defer transportB.Close()
	config := Config{
		BAP:           bap,
		Gateway:       gateway,
		Operators:     []Operator{{Name: "bmtc", Identity: bmtc}, {Name: "bmrcl", Identity: bmrcl}},
		CollectionTTL: 2 * time.Second,
		SignatureTTL:  time.Minute,
		ClockSkew:     time.Second,
	}
	instanceA, err := New(config, storeA, transportA, reg, nil)
	if err != nil {
		t.Fatal(err)
	}
	instanceB, err := New(config, storeB, transportB, reg, nil)
	if err != nil {
		t.Fatal(err)
	}
	if err := instanceB.Start(ctx); err != nil {
		t.Fatal(err)
	}
	callbackServer := httptest.NewServer(instanceB.BAPNetworkHandler())
	defer callbackServer.Close()

	_, err = transportA.Subscribe(ctx, "gateway.search", func(_ context.Context, message transport.Message) {
		var requestEnvelope envelope
		if err := json.Unmarshal(message.Data(), &requestEnvelope); err != nil {
			_ = message.Nack(err)
			return
		}
		var request payload
		if err := json.Unmarshal(requestEnvelope.Body, &request); err != nil {
			_ = message.Nack(err)
			return
		}
		for _, operator := range []Identity{bmtc, bmrcl} {
			callback := map[string]any{
				"context": map[string]any{
					"domain":         domain,
					"action":         "on_search",
					"transaction_id": request.Context.TransactionID,
					"message_id":     request.Context.MessageID,
					"bap_id":         bap.ID,
					"bap_uri":        bap.URI,
					"bpp_id":         operator.ID,
					"bpp_uri":        operator.URI,
				},
				"message": map[string]any{"catalog": map[string]any{"providers": []any{map[string]any{"id": "P1"}}}},
			}
			body, marshalErr := json.Marshal(callback)
			if marshalErr != nil {
				_ = message.Nack(marshalErr)
				return
			}
			now := time.Now()
			header, signErr := auth.Sign(body, operator.ID, operator.KeyID, operator.PrivateKey, now, now.Add(time.Minute))
			if signErr != nil {
				_ = message.Nack(signErr)
				return
			}
			req, requestErr := http.NewRequest(http.MethodPost, callbackServer.URL+"/on_search", strings.NewReader(string(body)))
			if requestErr != nil {
				_ = message.Nack(requestErr)
				return
			}
			req.Header.Set("Authorization", header)
			response, requestErr := http.DefaultClient.Do(req)
			if requestErr != nil {
				_ = message.Nack(requestErr)
				return
			}
			response.Body.Close()
			if response.StatusCode != http.StatusAccepted {
				_ = message.Nack(errors.New("callback network face did not ACK"))
				return
			}
		}
		_ = message.Ack()
	})
	if err != nil {
		t.Fatal(err)
	}

	clientServer := httptest.NewServer(instanceA.ClientHandler())
	defer clientServer.Close()
	search := `{"context":{"domain":"ONDC:TRV11","action":"search","transaction_id":"two-replica-transaction","message_id":"two-replica-message","bap_id":"bap.replica.test","bap_uri":"http://bap.replica.test"},"message":{"intent":{}}}`
	response, err := http.Post(clientServer.URL+"/search", "application/json", strings.NewReader(search))
	if err != nil {
		t.Fatal(err)
	}
	defer response.Body.Close()
	if response.StatusCode != http.StatusOK {
		t.Fatalf("search status = %d", response.StatusCode)
	}
	var result struct {
		Responses []json.RawMessage `json:"responses"`
	}
	if err := json.NewDecoder(response.Body).Decode(&result); err != nil {
		t.Fatal(err)
	}
	if len(result.Responses) != 2 {
		t.Fatalf("callbacks returned to instance A = %d, want 2", len(result.Responses))
	}
}
