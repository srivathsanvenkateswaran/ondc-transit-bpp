package network

import (
	"context"
	"crypto/ed25519"
	"encoding/base64"
	"encoding/json"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/gokul/ondc-transit-bpp/go-network/internal/auth"
	"github.com/gokul/ondc-transit-bpp/go-network/internal/pending"
	"github.com/gokul/ondc-transit-bpp/go-network/internal/registry"
	"github.com/gokul/ondc-transit-bpp/go-network/internal/transport"
)

func testIdentity(t *testing.T, id, keyID string) Identity {
	t.Helper()
	_, privateKey, err := ed25519.GenerateKey(nil)
	if err != nil {
		t.Fatal(err)
	}
	return Identity{ID: id, URI: "http://" + id, KeyID: keyID, PrivateKey: privateKey}
}
func seed(t *testing.T, store registry.Store, id Identity, typ string) {
	t.Helper()
	now := time.Now()
	err := store.Put(context.Background(), "test", registry.Subscriber{ID: id.ID, URI: id.URI, Type: typ, Domain: domain, KeyID: id.KeyID, PublicKey: base64.StdEncoding.EncodeToString(id.PrivateKey.Public().(ed25519.PublicKey)), ValidFrom: now.Add(-time.Hour), ValidTo: now.Add(time.Hour), Status: "SUBSCRIBED"})
	if err != nil {
		t.Fatal(err)
	}
}

func TestCollapsedSearchCollectsTwoSignedCallbacks(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	dir := t.TempDir()
	reg, err := registry.NewFileStore(dir + "/registry.json")
	if err != nil {
		t.Fatal(err)
	}
	tr := transport.NewMemoryTransport(3, time.Millisecond)
	defer tr.Close()
	store := pending.NewMemoryStore()
	defer store.Close()
	bap := testIdentity(t, "bap.test", "bap-key")
	gateway := testIdentity(t, "gateway.test", "gateway-key")
	bmtc := testIdentity(t, "bmtc.test", "bmtc-key")
	bmrcl := testIdentity(t, "bmrcl.test", "bmrcl-key")
	for _, item := range []struct {
		id  Identity
		typ string
	}{{bap, "BAP"}, {gateway, "BG"}, {bmtc, "BPP"}, {bmrcl, "BPP"}} {
		seed(t, reg, item.id, item.typ)
	}
	var mu sync.Mutex
	calls := map[string]int{}
	var clients map[string]*httptest.Server
	provider := func(name string) *httptest.Server {
		return httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			body, _ := io.ReadAll(r.Body)
			var request map[string]any
			_ = json.Unmarshal(body, &request)
			contextValue := request["context"].(map[string]any)
			contextValue["action"] = "on_" + contextValue["action"].(string)
			if name == "bmtc" {
				contextValue["bpp_id"] = bmtc.ID
				contextValue["bpp_uri"] = bmtc.URI
			} else {
				contextValue["bpp_id"] = bmrcl.ID
				contextValue["bpp_uri"] = bmrcl.URI
			}
			callback := map[string]any{"context": contextValue, "message": map[string]any{"catalog": map[string]any{"providers": []any{map[string]any{"id": "P1"}}}}}
			encoded, _ := json.Marshal(callback)
			mu.Lock()
			calls[name]++
			mu.Unlock()
			go func() {
				req, _ := http.NewRequest(http.MethodPost, clients[name].URL+"/on_search", strings.NewReader(string(encoded)))
				req.Header.Set("Content-Type", "application/json")
				resp, err := http.DefaultClient.Do(req)
				if err == nil {
					resp.Body.Close()
				}
			}()
			writeACK(w, http.StatusAccepted)
		}))
	}
	bmtcProvider := provider("bmtc")
	defer bmtcProvider.Close()
	bmrclProvider := provider("bmrcl")
	defer bmrclProvider.Close()
	app, err := New(Config{BAP: bap, Gateway: gateway, Operators: []Operator{{Name: "bmtc", Identity: bmtc, WebhookURL: bmtcProvider.URL}, {Name: "bmrcl", Identity: bmrcl, WebhookURL: bmrclProvider.URL}}, CollectionTTL: time.Second, SignatureTTL: time.Minute, ClockSkew: time.Second}, store, tr, reg, slog.New(slog.NewTextHandler(io.Discard, nil)))
	if err != nil {
		t.Fatal(err)
	}
	if err = app.Start(ctx); err != nil {
		t.Fatal(err)
	}
	clients = map[string]*httptest.Server{"bmtc": httptest.NewServer(app.BPPClientHandler("bmtc")), "bmrcl": httptest.NewServer(app.BPPClientHandler("bmrcl"))}
	defer clients["bmtc"].Close()
	defer clients["bmrcl"].Close()
	clientServer := httptest.NewServer(app.ClientHandler())
	defer clientServer.Close()
	body := `{"context":{"domain":"ONDC:TRV11","action":"search","transaction_id":"txn-1","message_id":"msg-1","bap_id":"bap.test","bap_uri":"http://bap.test"},"message":{"intent":{}}}`
	resp, err := http.Post(clientServer.URL+"/search", "application/json", strings.NewReader(body))
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	var result struct {
		Responses []json.RawMessage `json:"responses"`
	}
	if err = json.NewDecoder(resp.Body).Decode(&result); err != nil {
		t.Fatal(err)
	}
	if len(result.Responses) != 2 {
		t.Fatalf("callbacks = %d", len(result.Responses))
	}
	mu.Lock()
	defer mu.Unlock()
	if calls["bmtc"] != 1 || calls["bmrcl"] != 1 {
		t.Fatalf("provider calls = %#v", calls)
	}
}

func TestNetworkHTTPRejectsTamperedBody(t *testing.T) {
	dir := t.TempDir()
	reg, _ := registry.NewFileStore(dir + "/registry.json")
	tr := transport.NewMemoryTransport(1, 0)
	store := pending.NewMemoryStore()
	bap := testIdentity(t, "bap.test", "key")
	gateway := testIdentity(t, "gateway.test", "key")
	seed(t, reg, bap, "BAP")
	seed(t, reg, gateway, "BG")
	app, err := New(Config{BAP: bap, Gateway: gateway, SignatureTTL: time.Minute}, store, tr, reg, nil)
	if err != nil {
		t.Fatal(err)
	}
	server := httptest.NewServer(app.BAPNetworkHandler())
	defer server.Close()
	body := []byte(`{"context":{"domain":"ONDC:TRV11","action":"on_search"}}`)
	header, err := auth.Sign(body, bap.ID, bap.KeyID, bap.PrivateKey, time.Now(), time.Now().Add(time.Minute))
	if err != nil {
		t.Fatal(err)
	}
	tampered := []byte(`{"context":{"domain":"ONDC:TRV11","action":"on_status"}}`)
	req, _ := http.NewRequest(http.MethodPost, server.URL+"/on_search", strings.NewReader(string(tampered)))
	req.Header.Set("Authorization", header)
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusUnauthorized {
		t.Fatalf("status = %d", resp.StatusCode)
	}
}
