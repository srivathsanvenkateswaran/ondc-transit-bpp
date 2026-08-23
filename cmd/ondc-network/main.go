package main

import (
	"context"
	"crypto/ed25519"
	"encoding/base64"
	"errors"
	"fmt"
	"log/slog"
	"net/http"
	"os"
	"os/signal"
	"strconv"
	"strings"
	"syscall"
	"time"

	"github.com/gokul/ondc-transit-bpp/go-network/internal/keys"
	"github.com/gokul/ondc-transit-bpp/go-network/internal/network"
	"github.com/gokul/ondc-transit-bpp/go-network/internal/pending"
	"github.com/gokul/ondc-transit-bpp/go-network/internal/registry"
	"github.com/gokul/ondc-transit-bpp/go-network/internal/transport"
)

type serverSpec struct {
	name    string
	address string
	handler http.Handler
}

func main() {
	logger := slog.New(slog.NewJSONHandler(os.Stdout, &slog.HandlerOptions{Level: slog.LevelInfo}))
	if err := run(logger); err != nil {
		logger.Error("network stopped", "error", err)
		os.Exit(1)
	}
}
func run(logger *slog.Logger) error {
	mode := env("NETWORK_MODE", "collapsed")
	if mode != "collapsed" {
		return fmt.Errorf("NETWORK_MODE %q is not available from this entry point", mode)
	}
	ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
	defer stop()
	keyDir := env("NETWORK_KEY_DIR", "/var/lib/ondc-network/keys")
	registryPath := env("REGISTRY_FILE", "/var/lib/ondc-network/registry.json")
	reg, err := registry.NewFileStore(registryPath)
	if err != nil {
		return err
	}
	defer reg.Close()
	tr := transport.NewMemoryTransport(envInt("TRANSPORT_MAX_ATTEMPTS", 5), envDuration("TRANSPORT_RETRY_BACKOFF", 100*time.Millisecond))
	defer tr.Close()
	pendingStore := pending.NewMemoryStore()
	defer pendingStore.Close()
	bap, err := identity(keyDir, "bap", env("BAP_ID", "bap.transit.localhost"), env("BAP_URI", "http://ondc-network:5002"), env("BAP_KEY_ID", "bap-transit-key"))
	if err != nil {
		return err
	}
	gateway, err := identity(keyDir, "gateway", env("GATEWAY_ID", "gateway.transit.localhost"), env("GATEWAY_URI", "http://ondc-network:4030/bg"), env("GATEWAY_KEY_ID", "gateway-key"))
	if err != nil {
		return err
	}
	bmtc, err := identity(keyDir, "bmtc", env("BMTC_BPP_ID", "bmtc.bpp.transit.localhost"), env("BMTC_BPP_URI", "http://ondc-network:6002"), env("BMTC_BPP_KEY_ID", "bmtc-bpp-key"))
	if err != nil {
		return err
	}
	bmrcl, err := identity(keyDir, "bmrcl", env("BMRCL_BPP_ID", "bmrcl.bpp.transit.localhost"), env("BMRCL_BPP_URI", "http://ondc-network:6102"), env("BMRCL_BPP_KEY_ID", "bmrcl-bpp-key"))
	if err != nil {
		return err
	}
	for _, seed := range []struct {
		id  network.Identity
		typ string
	}{{bap, "BAP"}, {gateway, "BG"}, {bmtc, "BPP"}, {bmrcl, "BPP"}} {
		if err := seedRegistry(ctx, reg, seed.id, seed.typ); err != nil {
			return err
		}
	}
	cfg := network.Config{BAP: bap, Gateway: gateway, Operators: []network.Operator{{Name: "bmtc", Identity: bmtc, WebhookURL: env("BMTC_WEBHOOK_URL", "http://transit-bpp:7001/bmtc/inbound")}, {Name: "bmrcl", Identity: bmrcl, WebhookURL: env("BMRCL_WEBHOOK_URL", "http://transit-bpp:7001/bmrcl/inbound")}}, CollectionTTL: envDuration("COLLECTION_TTL", 4*time.Second), SignatureTTL: envDuration("SIGNATURE_TTL", 10*time.Minute), ClockSkew: envDuration("SIGNATURE_CLOCK_SKEW", 30*time.Second), MaxBodyBytes: int64(envInt("MAX_BODY_BYTES", 2<<20))}
	app, err := network.New(cfg, pendingStore, tr, reg, logger)
	if err != nil {
		return err
	}
	if err = app.Start(ctx); err != nil {
		return err
	}
	if port := os.Getenv("PORT"); port != "" {
		return runSinglePort(ctx, logger, app, reg, port, cfg.CollectionTTL)
	}
	servers := []serverSpec{{"registry", env("REGISTRY_LISTEN_ADDR", ":3030"), network.RegistryHandler(reg)}, {"gateway", env("GATEWAY_LISTEN_ADDR", ":4030"), app.GatewayHTTPHandler()}, {"bap-client", env("BAP_CLIENT_LISTEN_ADDR", ":5001"), app.ClientHandler()}, {"bap-network", env("BAP_NETWORK_LISTEN_ADDR", ":5002"), app.BAPNetworkHandler()}, {"bmtc-client", env("BMTC_CLIENT_LISTEN_ADDR", ":6001"), app.BPPClientHandler("bmtc")}, {"bmtc-network", env("BMTC_NETWORK_LISTEN_ADDR", ":6002"), app.BPPNetworkHandler("bmtc")}, {"bmrcl-client", env("BMRCL_CLIENT_LISTEN_ADDR", ":6101"), app.BPPClientHandler("bmrcl")}, {"bmrcl-network", env("BMRCL_NETWORK_LISTEN_ADDR", ":6102"), app.BPPNetworkHandler("bmrcl")}}
	errCh := make(chan error, len(servers))
	httpServers := make([]*http.Server, 0, len(servers))
	for _, spec := range servers {
		s := &http.Server{Addr: spec.address, Handler: spec.handler, ReadHeaderTimeout: 5 * time.Second, ReadTimeout: 15 * time.Second, WriteTimeout: cfg.CollectionTTL + 15*time.Second, IdleTimeout: 60 * time.Second, MaxHeaderBytes: 32 << 10}
		httpServers = append(httpServers, s)
		go func(spec serverSpec) {
			logger.Info("listener started", "role", spec.name, "address", spec.address)
			if err := s.ListenAndServe(); err != nil && !errors.Is(err, http.ErrServerClosed) {
				errCh <- fmt.Errorf("%s: %w", spec.name, err)
			}
		}(spec)
	}
	select {
	case <-ctx.Done():
	case err := <-errCh:
		return err
	}
	shutdownCtx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel()
	for _, s := range httpServers {
		_ = s.Shutdown(shutdownCtx)
	}
	return nil
}

func runSinglePort(ctx context.Context, logger *slog.Logger, app *network.App, reg registry.Store, port string, collectionTTL time.Duration) error {
	mux := http.NewServeMux()
	mux.Handle("/registry/", http.StripPrefix("/registry", network.RegistryHandler(reg)))
	mux.Handle("/bg/", preservePathMount("/bg", app.GatewayHTTPHandler()))
	mux.Handle("/bap/client/", http.StripPrefix("/bap/client", app.ClientHandler()))
	mux.Handle("/bap/network/", http.StripPrefix("/bap/network", app.BAPNetworkHandler()))
	mux.Handle("/bmtc/client/", http.StripPrefix("/bmtc/client", app.BPPClientHandler("bmtc")))
	mux.Handle("/bmtc/network/", http.StripPrefix("/bmtc/network", app.BPPNetworkHandler("bmtc")))
	mux.Handle("/bmrcl/client/", http.StripPrefix("/bmrcl/client", app.BPPClientHandler("bmrcl")))
	mux.Handle("/bmrcl/network/", http.StripPrefix("/bmrcl/network", app.BPPNetworkHandler("bmrcl")))
	mux.HandleFunc("GET /healthz", func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"status":"up"}`))
	})

	addr := ":" + port
	server := &http.Server{
		Addr:              addr,
		Handler:           mux,
		ReadHeaderTimeout: 5 * time.Second,
		ReadTimeout:       15 * time.Second,
		WriteTimeout:      collectionTTL + 15*time.Second,
		IdleTimeout:       60 * time.Second,
		MaxHeaderBytes:    32 << 10,
	}
	logger.Info("single-port listener started", "address", addr)
	errCh := make(chan error, 1)
	go func() {
		if err := server.ListenAndServe(); err != nil && !errors.Is(err, http.ErrServerClosed) {
			errCh <- err
		}
	}()
	select {
	case <-ctx.Done():
	case err := <-errCh:
		return err
	}
	shutdownCtx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel()
	return server.Shutdown(shutdownCtx)
}

func preservePathMount(prefix string, handler http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != prefix && !strings.HasPrefix(r.URL.Path, prefix+"/") {
			http.NotFound(w, r)
			return
		}
		handler.ServeHTTP(w, r)
	})
}

func identity(dir, name, id, uri, keyID string) (network.Identity, error) {
	privateKey, err := keys.LoadOrCreate(dir, name)
	return network.Identity{ID: id, URI: uri, KeyID: keyID, PrivateKey: privateKey}, err
}
func seedRegistry(ctx context.Context, reg registry.Store, id network.Identity, typ string) error {
	now := time.Now().UTC()
	publicKey := id.PrivateKey.Public().(ed25519.PublicKey)
	return reg.Put(ctx, "startup", registry.Subscriber{ID: id.ID, URI: id.URI, Type: typ, Domain: "ONDC:TRV11", KeyID: id.KeyID, PublicKey: base64.StdEncoding.EncodeToString(publicKey), ValidFrom: now.Add(-time.Minute), ValidTo: now.AddDate(10, 0, 0), Status: "SUBSCRIBED"})
}
func env(name, fallback string) string {
	if value := os.Getenv(name); value != "" {
		return value
	}
	return fallback
}
func envInt(name string, fallback int) int {
	value := os.Getenv(name)
	if value == "" {
		return fallback
	}
	parsed, err := strconv.Atoi(value)
	if err != nil || parsed <= 0 {
		return fallback
	}
	return parsed
}
func envDuration(name string, fallback time.Duration) time.Duration {
	value := os.Getenv(name)
	if value == "" {
		return fallback
	}
	parsed, err := time.ParseDuration(value)
	if err != nil {
		return fallback
	}
	return parsed
}
