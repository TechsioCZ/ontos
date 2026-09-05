// expect-count: 3
// V8 stack surgery reached through a computed key and through the non-`globalThis` container globals.
export const viaComputed = (target: object): void => {
	Error["captureStackTrace"](target);
};

export const viaSelf = self.Error.captureStackTrace;

export const viaFrames = frames.Error.captureStackTrace;
