export const LIVE_EXCHANGE_INTERFACE_VERSION = "live-exchange-port-v1";

export const LIVE_EXCHANGE_OPERATIONS = Object.freeze([
  "getSpotAccount",
  "placeSpotOrder",
  "cancelSpotOrder",
  "getFuturesAccount",
  "placeFuturesOrder",
  "cancelFuturesOrder",
  "setLeverage"
]);

function disabled(operation) {
  const error = new Error(`${operation} is interface-only: exchange account/trading is disabled in Paper mode`);
  error.code = "LIVE_EXCHANGE_WRITE_DISABLED";
  throw error;
}

/**
 * Stable port for a future, separately approved live adapter.
 *
 * No credential is read and no private endpoint is called here.  Consumers can
 * be written against this shape without weakening the current Paper-only safety
 * boundary.  A real implementation must be introduced behind an explicit
 * deployment approval, not by changing this default factory.
 */
export function createDisabledLiveExchangeInterface() {
  return Object.freeze({
    version: LIVE_EXCHANGE_INTERFACE_VERSION,
    mode: "INTERFACE_ONLY_PAPER_DEFAULT",
    exchangeWriteEnabled: false,
    authenticationLoaded: false,
    getSpotAccount: async () => disabled("getSpotAccount"),
    placeSpotOrder: async () => disabled("placeSpotOrder"),
    cancelSpotOrder: async () => disabled("cancelSpotOrder"),
    getFuturesAccount: async () => disabled("getFuturesAccount"),
    placeFuturesOrder: async () => disabled("placeFuturesOrder"),
    cancelFuturesOrder: async () => disabled("cancelFuturesOrder"),
    setLeverage: async () => disabled("setLeverage")
  });
}
