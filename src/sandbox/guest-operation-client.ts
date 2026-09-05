/** Internal module boundary for the controller-side guest client. The public
 * package intentionally does not export the raw supervisor protocol. */
export { GuestOperationClient, GuestProtocolError, GuestFrameDecoder, encodeGuestFrame, makeGuestRequest, parseGuestMessage, sameBinding, validateBinding, assertBinding, guestOperationPayloadDigest, GUEST_OPERATIONS, GUEST_PROTOCOL_VERSION, MAX_GUEST_FRAME_BYTES, MAX_GUEST_OUTPUT_BYTES } from "./guest-protocol.js";
export type { GuestBinding, GuestOperation, GuestOperationRequest, GuestOperationResponse, GuestProtocolLimits } from "./guest-protocol.js";
