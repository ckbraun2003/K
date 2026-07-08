// core/src/notify.ts (W0 stub — Lane B lands the engine)
/**
 * E-19 notification engine registration seam (mirrors run-verify.ts::registerRunVerify).
 * W0 stub: subscribes to nothing and returns a no-op unsubscribe; Lane B replaces
 * the body with the rules-gated run_update/verify_update → notifications pipeline.
 */
export function registerNotifications(): () => void {
  return () => {}
}
