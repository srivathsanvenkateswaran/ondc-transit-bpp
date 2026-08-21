package network

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/gokul/ondc-transit-bpp/go-network/internal/pending"
	"github.com/gokul/ondc-transit-bpp/go-network/internal/registry"
	"github.com/gokul/ondc-transit-bpp/go-network/internal/transport"
)

type recordingTransport struct {
	transport.Transport
	mu     sync.Mutex
	topics []string
}

func (t *recordingTransport) Publish(ctx context.Context, topic string, data []byte) error {
	t.mu.Lock()
	t.topics = append(t.topics, topic)
	t.mu.Unlock()
	return t.Transport.Publish(ctx, topic, data)
}

func (t *recordingTransport) published(topic string) bool {
	t.mu.Lock()
	defer t.mu.Unlock()
	for _, candidate := range t.topics {
		if candidate == topic {
			return true
		}
	}
	return false
}

func TestLifecycleEvidenceReplay(t *testing.T) {
	tests := []struct {
		operator string
		action   string
	}{
		{"bmtc", "select"},
		{"bmtc", "init"},
		{"bmtc", "confirm"},
		{"bmtc", "status"},
		{"bmrcl", "select"},
		{"bmrcl", "init"},
		{"bmrcl", "confirm"},
		{"bmrcl", "status"},
	}

	for _, test := range tests {
		t.Run(test.operator+"_"+test.action, func(t *testing.T) {
			callbackResult := make(chan string, 1)
			requestPath := filepath.Join("..", "..", "phase-2", "evidence", test.operator+"-"+test.action+"-request.json")
			responsePath := filepath.Join("..", "..", "phase-2", "evidence", test.operator+"-"+test.action+"-response.raw.json")
			requestBody, err := os.ReadFile(requestPath)
			if err != nil {
				t.Fatal(err)
			}
			expectedCallback := readEvidenceCallback(t, responsePath)
			expectedBody, err := json.Marshal(expectedCallback)
			if err != nil {
				t.Fatal(err)
			}

			ctx, cancel := context.WithCancel(context.Background())
			defer cancel()
			reg, err := registry.NewFileStore(filepath.Join(t.TempDir(), "registry.json"))
			if err != nil {
				t.Fatal(err)
			}
			pendingStore := pending.NewMemoryStore()
			defer pendingStore.Close()
			memoryTransport := transport.NewMemoryTransport(3, time.Millisecond)
			defer memoryTransport.Close()
			tr := &recordingTransport{Transport: memoryTransport}

			bap := testIdentity(t, "bap.transit.localhost", "bap-transit-key")
			gateway := testIdentity(t, "gateway.transit.localhost", "gateway-key")
			bmtc := testIdentity(t, "bmtc.bpp.transit.localhost", "bmtc-bpp-key")
			bmrcl := testIdentity(t, "bmrcl.bpp.transit.localhost", "bmrcl-bpp-key")
			for _, participant := range []struct {
				identity Identity
				typ      string
			}{{bap, "BAP"}, {gateway, "BG"}, {bmtc, "BPP"}, {bmrcl, "BPP"}} {
				seed(t, reg, participant.identity, participant.typ)
			}

			var callbackClient *httptest.Server
			provider := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, request *http.Request) {
				if request.URL.Path != "/"+test.operator+"/inbound" {
					http.Error(w, "unexpected provider path", http.StatusNotFound)
					return
				}
				go func() {
					callbackRequest, callbackErr := http.NewRequest(http.MethodPost, callbackClient.URL+"/on_"+test.action, strings.NewReader(string(expectedBody)))
					if callbackErr != nil {
						callbackResult <- callbackErr.Error()
						return
					}
					callbackRequest.Header.Set("Content-Type", "application/json")
					callbackResponse, callbackErr := http.DefaultClient.Do(callbackRequest)
					if callbackErr == nil {
						callbackResult <- callbackResponse.Status
						callbackResponse.Body.Close()
					} else {
						callbackResult <- callbackErr.Error()
					}
				}()
				writeACK(w, http.StatusAccepted)
			}))
			defer provider.Close()

			config := Config{
				BAP:           bap,
				Gateway:       gateway,
				Operators:     []Operator{{Name: "bmtc", Identity: bmtc}, {Name: "bmrcl", Identity: bmrcl}},
				CollectionTTL: time.Second,
				SignatureTTL:  time.Minute,
				ClockSkew:     time.Second,
			}
			for index := range config.Operators {
				config.Operators[index].WebhookURL = provider.URL + "/" + config.Operators[index].Name + "/inbound"
			}
			app, err := New(config, pendingStore, tr, reg, nil)
			if err != nil {
				t.Fatal(err)
			}
			if err := app.Start(ctx); err != nil {
				t.Fatal(err)
			}
			callbackClient = httptest.NewServer(app.BPPClientHandler(test.operator))
			defer callbackClient.Close()
			client := httptest.NewServer(app.ClientHandler())
			defer client.Close()

			response, err := http.Post(client.URL+"/"+test.action, "application/json", strings.NewReader(string(requestBody)))
			if err != nil {
				t.Fatal(err)
			}
			defer response.Body.Close()
			if response.StatusCode != http.StatusOK {
				body, _ := io.ReadAll(response.Body)
				t.Fatalf("HTTP %d: %s", response.StatusCode, body)
			}
			var actual struct {
				Responses []any `json:"responses"`
			}
			if err := json.NewDecoder(response.Body).Decode(&actual); err != nil {
				t.Fatal(err)
			}
			if len(actual.Responses) != 1 {
				result := "no callback result"
				select {
				case result = <-callbackResult:
				default:
				}
				t.Fatalf("callbacks = %d, want 1; callback delivery = %s", len(actual.Responses), result)
			}
			if !reflect.DeepEqual(normalizeEvidence(actual.Responses[0]), normalizeEvidence(expectedCallback)) {
				actualJSON, _ := json.MarshalIndent(normalizeEvidence(actual.Responses[0]), "", "  ")
				expectedJSON, _ := json.MarshalIndent(normalizeEvidence(expectedCallback), "", "  ")
				t.Fatalf("callback mismatch\nactual:\n%s\nexpected:\n%s", actualJSON, expectedJSON)
			}
			if tr.published("gateway.search") {
				t.Fatalf("%s was published through the gateway", test.action)
			}
		})
	}
}

func TestCommittedGatewayEvidenceContainsSearchOnly(t *testing.T) {
	data, err := os.ReadFile(filepath.Join("..", "..", "phase-2", "evidence", "gateway-phase2.raw.txt"))
	if err != nil {
		t.Fatal(err)
	}
	log := strings.ToLower(string(data))
	if !strings.Contains(log, "/search") {
		t.Fatal("gateway evidence contains no search")
	}
	for _, forbidden := range []string{"/select", "/init", "/confirm", "/status"} {
		if strings.Contains(log, forbidden) {
			t.Fatalf("gateway evidence unexpectedly contains %s", forbidden)
		}
	}
}

func readEvidenceCallback(t *testing.T, path string) any {
	t.Helper()
	data, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	var envelope struct {
		Responses []any `json:"responses"`
	}
	if err := json.Unmarshal(data, &envelope); err != nil {
		t.Fatal(err)
	}
	if len(envelope.Responses) != 1 {
		t.Fatalf("%s contains %d callbacks", path, len(envelope.Responses))
	}
	return envelope.Responses[0]
}

func normalizeEvidence(value any) any {
	switch typed := value.(type) {
	case map[string]any:
		result := make(map[string]any, len(typed))
		for key, child := range typed {
			switch key {
			case "timestamp", "created_at", "updated_at", "signature":
				continue
			}
			result[key] = normalizeEvidence(child)
		}
		return result
	case []any:
		result := make([]any, len(typed))
		for index := range typed {
			result[index] = normalizeEvidence(typed[index])
		}
		return result
	default:
		return typed
	}
}
