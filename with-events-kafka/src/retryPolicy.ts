/**
 * In-process retries the retry middleware makes after a failed handler call,
 * before the failure reaches the adapter and the message is redelivered.
 */
export const MAX_RETRIES = 3;
