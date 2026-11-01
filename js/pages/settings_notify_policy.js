import {
  portalNotifyQueueRetry_,
  portalNotifyQueueReadiness_,
} from "./portal_api.js";

export async function retryNotifyQueueForSettings_(idToken, payload) {
  return portalNotifyQueueRetry_(idToken, payload);
}

export async function readinessNotifyQueueForSettings_(idToken, payload) {
  return portalNotifyQueueReadiness_(idToken, payload);
}
