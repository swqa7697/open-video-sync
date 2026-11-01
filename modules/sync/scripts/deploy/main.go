// Command deploy builds and transfers OVS releases over SSH. The same executable
// runs as a short-lived remote helper; the server does not need Go installed.
package main

import (
	"context"
	"fmt"
	"os"
	"os/signal"
	"syscall"

	"github.com/swqa7697/open-video-sync/modules/sync/scripts/internal/checkout"
)

func main() {
	ctx, cancel := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM, syscall.SIGHUP)
	defer cancel()
	var err error
	if len(os.Args) == 3 && os.Args[1] == "remote" {
		remoteCtx, stop := remoteContext(ctx)
		defer stop()
		err = serve(remoteCtx, os.Args[2], os.Stdin, os.Stdout)
	} else if len(os.Args) == 2 {
		if err = checkout.EnterRoot(); err == nil {
			err = runLocal(ctx, os.Args[1])
		}
	} else {
		err = fmt.Errorf("usage: deploy {deploy|status|logs|restart|stop}; configure HOST, URL, IMAGE, DEPLOY_DIR, PROXY, PROXY_NETWORK, TRUSTED_PROXIES, PROXY_SUBNET through environment")
	}
	if err != nil {
		fmt.Fprintln(os.Stderr, "deploy:", err)
		os.Exit(1)
	}
}
