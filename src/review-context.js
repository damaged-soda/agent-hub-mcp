export const REVIEW_CONTEXT_VERSION = 1;
export const REVIEW_DEPTH_ENV = "AGENT_HUB_REVIEW_DEPTH";

const REVIEW_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9-]*$/;

export function createReviewContext({ requester, reviewer }) {
  return normalizeReviewContext({
    version: REVIEW_CONTEXT_VERSION,
    requester,
    reviewer,
    depth: 1,
  });
}

export function normalizeReviewContext(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw reviewContextError("review_context must be an object");
  }
  if (value.version !== REVIEW_CONTEXT_VERSION) {
    throw reviewContextError("review_context.version is unsupported");
  }
  if (!isReviewId(value.requester) || !isReviewId(value.reviewer)) {
    throw reviewContextError("review_context requester and reviewer must be valid agent ids");
  }
  if (!Number.isSafeInteger(value.depth) || value.depth < 1) {
    throw reviewContextError("review_context.depth must be a positive integer");
  }
  return {
    version: REVIEW_CONTEXT_VERSION,
    requester: value.requester,
    reviewer: value.reviewer,
    depth: value.depth,
  };
}

export function reviewContextEnv(context) {
  const normalized = normalizeReviewContext(context);
  return { [REVIEW_DEPTH_ENV]: String(normalized.depth) };
}

export function assertReviewDispatchAllowed(env = process.env) {
  const rawDepth = env?.[REVIEW_DEPTH_ENV];
  if (rawDepth === undefined || rawDepth === "") return;

  if (!/^[1-9][0-9]*$/.test(rawDepth)) {
    throw reviewContextError(`${REVIEW_DEPTH_ENV} must be a positive integer`);
  }
  const depth = Number(rawDepth);
  if (!Number.isSafeInteger(depth)) {
    throw reviewContextError(`${REVIEW_DEPTH_ENV} is outside the safe integer range`);
  }

  const error = new Error(
    "An active Agent Hub review session cannot dispatch another review",
  );
  error.code = "nested_review_forbidden";
  throw error;
}

function isReviewId(value) {
  return typeof value === "string" && REVIEW_ID_PATTERN.test(value);
}

function reviewContextError(message) {
  const error = new Error(message);
  error.code = "review_context_invalid";
  return error;
}
