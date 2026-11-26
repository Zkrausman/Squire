// Associate only known pre-reservation request failures with the existing family errors.
// The CLI never reads messages or properties of errors from I/O or caller-supplied ports.
const feedback=new WeakMap();
const requestIssues=new Set(['MALFORMED_REQUEST','PACKAGE_BINDING_MISMATCH','ATTESTATION_REQUIRED','BINARY_ACKNOWLEDGEMENT_REQUIRED']);

export function recordFailure(error,issue){
  if(requestIssues.has(issue))feedback.set(error,issue);
  else feedback.delete(error);
  return error;
}
export function decisionFeedback(error){
  return feedback.get(error);
}
