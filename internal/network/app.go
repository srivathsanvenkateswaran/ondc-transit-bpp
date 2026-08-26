package network

import (
	"bytes"
	"context"
	"crypto/ed25519"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"strings"
	"time"

	"github.com/gokul/ondc-transit-bpp/go-network/internal/auth"
	"github.com/gokul/ondc-transit-bpp/go-network/internal/pending"
	"github.com/gokul/ondc-transit-bpp/go-network/internal/registry"
	"github.com/gokul/ondc-transit-bpp/go-network/internal/transport"
)

const domain = "ONDC:TRV11"

type Identity struct {
	ID, URI, KeyID string
	PrivateKey     ed25519.PrivateKey
}
type Operator struct {
	Name       string
	Identity   Identity
	WebhookURL string
}
type Config struct {
	BAP           Identity
	Gateway       Identity
	Operators     []Operator
	CollectionTTL time.Duration
	SignatureTTL  time.Duration
	ClockSkew     time.Duration
	MaxBodyBytes  int64
}
type envelope struct {
	Authorization        string `json:"authorization"`
	GatewayAuthorization string `json:"gateway_authorization,omitempty"`
	Body                 []byte `json:"body"`
}
type contextFields struct {
	Action        string `json:"action"`
	Domain        string `json:"domain"`
	TransactionID string `json:"transaction_id"`
	MessageID     string `json:"message_id"`
	BAPID         string `json:"bap_id"`
	BAPURI        string `json:"bap_uri"`
	BPPID         string `json:"bpp_id"`
	BPPURI        string `json:"bpp_uri"`
}
type payload struct {
	Context contextFields `json:"context"`
}

type App struct {
	cfg       Config
	pending   pending.Store
	transport transport.Transport
	registry  registry.Store
	client    *http.Client
	log       *slog.Logger
}

func New(cfg Config, p pending.Store, tr transport.Transport, reg registry.Store, logger *slog.Logger) (*App, error) {
	if len(cfg.BAP.PrivateKey) != ed25519.PrivateKeySize || len(cfg.Gateway.PrivateKey) != ed25519.PrivateKeySize {
		return nil, errors.New("BAP and gateway signing keys are required")
	}
	if cfg.CollectionTTL <= 0 {
		cfg.CollectionTTL = 4 * time.Second
	}
	if cfg.SignatureTTL <= 0 {
		cfg.SignatureTTL = 10 * time.Minute
	}
	if cfg.MaxBodyBytes <= 0 {
		cfg.MaxBodyBytes = 2 << 20
	}
	if logger == nil {
		logger = slog.Default()
	}
	return &App{cfg: cfg, pending: p, transport: tr, registry: reg, client: &http.Client{Timeout: 10 * time.Second}, log: logger}, nil
}

func (a *App) Start(ctx context.Context) error {
	if _, err := a.transport.Subscribe(ctx, "gateway.search", a.gatewayHandler); err != nil {
		return err
	}
	if _, err := a.transport.Subscribe(ctx, "bap.network", a.bapNetworkHandler); err != nil {
		return err
	}
	for _, operator := range a.cfg.Operators {
		op := operator
		if _, err := a.transport.Subscribe(ctx, "bpp."+op.Name+".network", func(ctx context.Context, msg transport.Message) { a.bppNetworkHandler(ctx, op, msg) }); err != nil {
			return err
		}
	}
	return nil
}

func (a *App) ClientHandler() http.Handler {
	mux := http.NewServeMux()
	for _, action := range []string{"search", "select", "init", "confirm", "status"} {
		mux.HandleFunc("POST /"+action, a.handleClient)
	}
	a.health(mux, true)
	return mux
}
func (a *App) BAPNetworkHandler() http.Handler {
	mux := http.NewServeMux()
	for _, action := range []string{"on_search", "on_select", "on_init", "on_confirm", "on_status"} {
		mux.HandleFunc("POST /"+action, a.handleBAPNetworkHTTP)
	}
	a.health(mux, false)
	return mux
}
func (a *App) BPPClientHandler(name string) http.Handler {
	mux := http.NewServeMux()
	for _, action := range []string{"on_search", "on_select", "on_init", "on_confirm", "on_status"} {
		mux.HandleFunc("POST /"+action, func(w http.ResponseWriter, r *http.Request) { a.handleBPPClientHTTP(name, w, r) })
	}
	a.health(mux, true)
	return mux
}
func (a *App) BPPNetworkHandler(name string) http.Handler {
	mux := http.NewServeMux()
	for _, action := range []string{"search", "select", "init", "confirm", "status"} {
		mux.HandleFunc("POST /"+action, func(w http.ResponseWriter, r *http.Request) { a.handleBPPNetworkHTTP(name, w, r) })
	}
	a.health(mux, false)
	return mux
}

func (a *App) handleClient(w http.ResponseWriter, r *http.Request) {
	body, err := a.readBody(r)
	if err != nil {
		writeError(w, http.StatusBadRequest, err)
		return
	}
	var p payload
	if json.Unmarshal(body, &p) != nil || p.Context.Action == "" || p.Context.TransactionID == "" || p.Context.MessageID == "" {
		writeError(w, http.StatusBadRequest, errors.New("invalid Beckn context"))
		return
	}
	correlation := p.Context.TransactionID + "|" + p.Context.MessageID + "|on_" + p.Context.Action
	if err = a.pending.Claim(r.Context(), correlation, a.cfg.CollectionTTL); err != nil {
		writeError(w, http.StatusConflict, err)
		return
	}
	defer a.pending.Release(context.Background(), correlation)
	env, err := a.signedEnvelope(body, a.cfg.BAP)
	if err != nil {
		writeError(w, 500, err)
		return
	}
	topic := "gateway.search"
	expected := 2
	if p.Context.Action != "search" {
		expected = 1
		topic = a.operatorTopic(p.Context.BPPID)
		if topic == "" {
			writeError(w, 400, errors.New("direct action requires a known bpp_id"))
			return
		}
	}
	encoded, _ := json.Marshal(env)
	if err = a.transport.Publish(r.Context(), topic, encoded); err != nil {
		writeError(w, 503, err)
		return
	}
	callbacks, err := a.pending.Await(r.Context(), correlation, expected)
	if err != nil && !errors.Is(err, pending.ErrExpired) {
		writeError(w, 504, err)
		return
	}
	responses := make([]json.RawMessage, len(callbacks))
	for i := range callbacks {
		responses[i] = callbacks[i]
	}
	writeJSON(w, 200, map[string]any{"context": p.Context, "responses": responses})
}

func (a *App) gatewayHandler(ctx context.Context, msg transport.Message) {
	var env envelope
	if json.Unmarshal(msg.Data(), &env) != nil {
		_ = msg.Nack(errors.New("invalid envelope"))
		return
	}
	p, err := a.verify(env.Body, env.Authorization)
	if err != nil {
		_ = msg.Nack(err)
		return
	}
	if p.Context.Action != "search" {
		_ = msg.Nack(errors.New("gateway only accepts search"))
		return
	}
	subs, err := a.registry.Lookup(ctx, p.Context.Domain, "BPP", time.Now())
	if err != nil {
		_ = msg.Nack(err)
		return
	}
	gatewayHeader, err := a.sign(env.Body, a.cfg.Gateway)
	if err != nil {
		_ = msg.Nack(err)
		return
	}
	env.GatewayAuthorization = gatewayHeader
	encoded, _ := json.Marshal(env)
	for _, sub := range subs {
		topic := a.operatorTopic(sub.ID)
		if topic == "" {
			continue
		}
		a.log.Info("gateway fanout", "action", "search", "bpp_id", sub.ID, "bpp_uri", sub.URI)
		if err = a.transport.Publish(ctx, topic, encoded); err != nil {
			_ = msg.Nack(err)
			return
		}
	}
	_ = msg.Ack()
}

func (a *App) bppNetworkHandler(ctx context.Context, op Operator, msg transport.Message) {
	var env envelope
	if json.Unmarshal(msg.Data(), &env) != nil {
		a.log.Warn("BPP network rejected envelope", "operator", op.Name, "error", "invalid envelope")
		_ = msg.Nack(errors.New("invalid envelope"))
		return
	}
	p, err := a.verify(env.Body, env.Authorization)
	if err != nil {
		a.log.Warn("BPP network rejected signature", "operator", op.Name, "error", err)
		_ = msg.Nack(err)
		return
	}
	if p.Context.Action == "search" && env.GatewayAuthorization != "" {
		if _, err = a.verify(env.Body, env.GatewayAuthorization); err != nil {
			_ = msg.Nack(err)
			return
		}
	}
	if p.Context.Action != "search" && p.Context.BPPID != op.Identity.ID {
		a.log.Warn("BPP network rejected address", "operator", op.Name, "bpp_id", p.Context.BPPID)
		_ = msg.Nack(errors.New("request addressed to another BPP"))
		return
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, op.WebhookURL, bytes.NewReader(env.Body))
	if err != nil {
		_ = msg.Nack(err)
		return
	}
	req.Header.Set("Content-Type", "application/json")
	resp, err := a.client.Do(req)
	if err != nil {
		a.log.Warn("provider request failed", "operator", op.Name, "action", p.Context.Action, "error", err)
		_ = msg.Nack(err)
		return
	}
	responseBody, _ := io.ReadAll(io.LimitReader(resp.Body, 64<<10))
	resp.Body.Close()
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		a.log.Warn("provider rejected request", "operator", op.Name, "action", p.Context.Action, "status", resp.StatusCode)
		_ = msg.Nack(fmt.Errorf("provider HTTP %d: %s", resp.StatusCode, responseBody))
		return
	}
	a.log.Info("provider accepted", "operator", op.Name, "action", p.Context.Action, "transaction_id", p.Context.TransactionID)
	_ = msg.Ack()
}

func (a *App) bapNetworkHandler(_ context.Context, msg transport.Message) {
	var env envelope
	if json.Unmarshal(msg.Data(), &env) != nil {
		_ = msg.Nack(errors.New("invalid envelope"))
		return
	}
	p, err := a.verify(env.Body, env.Authorization)
	if err != nil {
		_ = msg.Nack(err)
		return
	}
	if !strings.HasPrefix(p.Context.Action, "on_") {
		_ = msg.Nack(errors.New("BAP network accepts callbacks only"))
		return
	}
	correlation := p.Context.TransactionID + "|" + p.Context.MessageID + "|" + p.Context.Action
	if err = a.pending.Append(context.Background(), correlation, env.Body); err != nil {
		if errors.Is(err, pending.ErrExpired) || errors.Is(err, pending.ErrNotFound) {
			_ = msg.Ack()
			return
		}
		_ = msg.Nack(err)
		return
	}
	_ = msg.Ack()
}

func (a *App) handleBPPClientHTTP(name string, w http.ResponseWriter, r *http.Request) {
	body, err := a.readBody(r)
	if err != nil {
		writeError(w, 400, err)
		return
	}
	op, ok := a.operator(name)
	if !ok {
		writeError(w, 404, errors.New("operator not found"))
		return
	}
	env, err := a.signedEnvelope(body, op.Identity)
	if err != nil {
		writeError(w, 500, err)
		return
	}
	encoded, _ := json.Marshal(env)
	if err = a.transport.Publish(r.Context(), "bap.network", encoded); err != nil {
		writeError(w, 503, err)
		return
	}
	writeACK(w, http.StatusAccepted)
}
func (a *App) handleBAPNetworkHTTP(w http.ResponseWriter, r *http.Request) {
	a.handleNetworkHTTP("bap.network", w, r)
}
func (a *App) handleBPPNetworkHTTP(name string, w http.ResponseWriter, r *http.Request) {
	a.handleNetworkHTTP("bpp."+name+".network", w, r)
}
func (a *App) handleNetworkHTTP(topic string, w http.ResponseWriter, r *http.Request) {
	body, err := a.readBody(r)
	if err != nil {
		writeError(w, 400, err)
		return
	}
	header := r.Header.Get("Authorization")
	if _, err = a.verify(body, header); err != nil {
		writeNACK(w, http.StatusUnauthorized, "Authentication failed")
		return
	}
	env := envelope{Authorization: header, GatewayAuthorization: r.Header.Get("X-Gateway-Authorization"), Body: body}
	encoded, _ := json.Marshal(env)
	if err = a.transport.Publish(r.Context(), topic, encoded); err != nil {
		writeError(w, 503, err)
		return
	}
	writeACK(w, http.StatusAccepted)
}

func (a *App) signedEnvelope(body []byte, id Identity) (envelope, error) {
	h, err := a.sign(body, id)
	return envelope{Authorization: h, Body: body}, err
}
func (a *App) sign(body []byte, id Identity) (string, error) {
	now := time.Now()
	return auth.Sign(body, id.ID, id.KeyID, id.PrivateKey, now, now.Add(a.cfg.SignatureTTL))
}
func (a *App) verify(body []byte, header string) (payload, error) {
	var p payload
	if err := json.Unmarshal(body, &p); err != nil {
		return p, err
	}
	parsed, err := auth.Parse(header)
	if err != nil {
		return p, err
	}
	sub, err := a.registry.Get(context.Background(), parsed.SubscriberID, parsed.UniqueKeyID, time.Now())
	if err != nil {
		return p, err
	}
	key, err := base64.StdEncoding.DecodeString(sub.PublicKey)
	if err != nil {
		return p, err
	}
	_, err = auth.Verify(body, header, ed25519.PublicKey(key), time.Now(), a.cfg.ClockSkew)
	return p, err
}
func (a *App) operator(name string) (Operator, bool) {
	for _, op := range a.cfg.Operators {
		if op.Name == name {
			return op, true
		}
	}
	return Operator{}, false
}
func (a *App) operatorTopic(id string) string {
	for _, op := range a.cfg.Operators {
		if op.Identity.ID == id {
			return "bpp." + op.Name + ".network"
		}
	}
	return ""
}
func (a *App) readBody(r *http.Request) ([]byte, error) {
	defer r.Body.Close()
	body, err := io.ReadAll(io.LimitReader(r.Body, a.cfg.MaxBodyBytes+1))
	if err != nil {
		return nil, err
	}
	if int64(len(body)) > a.cfg.MaxBodyBytes {
		return nil, errors.New("request body too large")
	}
	return body, nil
}
func (a *App) health(mux *http.ServeMux, internal bool) {
	mux.HandleFunc("GET /healthz", func(w http.ResponseWriter, _ *http.Request) { writeJSON(w, 200, map[string]string{"status": "up"}) })
	mux.HandleFunc("GET /readyz", func(w http.ResponseWriter, r *http.Request) {
		if err := a.transport.Ready(r.Context()); err != nil {
			writeError(w, 503, err)
			return
		}
		if err := a.registry.Ready(r.Context()); err != nil {
			writeError(w, 503, err)
			return
		}
		if internal {
			if err := a.pending.Ready(r.Context()); err != nil {
				writeError(w, 503, err)
				return
			}
		}
		writeJSON(w, 200, map[string]string{"status": "ready"})
	})
}
func writeJSON(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(v)
}
func writeACK(w http.ResponseWriter, status int) {
	writeJSON(w, status, map[string]any{"message": map[string]any{"ack": map[string]string{"status": "ACK"}}})
}
func writeNACK(w http.ResponseWriter, status int, message string) {
	writeJSON(w, status, map[string]any{"message": map[string]any{"ack": map[string]string{"status": "NACK"}}, "error": map[string]string{"message": message}})
}
func writeError(w http.ResponseWriter, status int, err error) { writeNACK(w, status, err.Error()) }
