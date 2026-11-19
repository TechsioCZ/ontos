// Closed TEST transport fault. It cannot supply an outcome or bypass the real Action.
export const makeReportResponseLossControl = () => {
  let armed = false;
  let discardedResponses = 0;
  let committedResponseStatus: number | null = null;
  return {
    arm: () => {
      if (armed || discardedResponses !== 0) {
        return false;
      }
      armed = true;
      return true;
    },
    discard: (method: string, url: string, status: number, close: () => void) => {
      if (
        !armed ||
        method !== 'POST' ||
        url !== '/privacy/actions/record-owner-execution-outcome' ||
        status < 200 ||
        status >= 300
      ) {
        return false;
      }
      armed = false;
      close();
      discardedResponses += 1;
      committedResponseStatus = status;
      return true;
    },
    observe: () => ({ armed, committedResponseStatus, discardedResponses }),
  };
};
