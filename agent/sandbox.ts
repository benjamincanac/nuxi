import { defaultBackend, defineSandbox } from "eve/sandbox";

/**
 * Reproductions are untrusted code. Sessions start with no egress at all, and `run_sandbox_repro`
 * opens the npm registry, plus the host of the next major build, right before it installs.
 */
export default defineSandbox({
  backend: defaultBackend({
    vercel: { networkPolicy: "deny-all", resources: { vcpus: 2 } },
    docker: { networkPolicy: "deny-all" },
  }),
});
