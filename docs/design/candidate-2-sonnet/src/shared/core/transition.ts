// core/transition.ts -- the one shape every pure state machine returns.
//
// A machine is  step(state, event) -> { state, commands }.  It does no IO. The shell
// (pipeline/*, review/*) persists `state` and executes `commands`. Rules that say
// "X never causes Y" become a COMMAND TYPE that does not contain Y:
//   R5  chooseLater returns Transition<InviteState, never>   (it cannot emit CancelScope)
//   R9  capture and review machines share no event or command type
export interface Transition<S, C> {
  readonly state: S;
  readonly commands: readonly C[];
}

/** An event that is illegal in the current state is reported, not thrown: replayed logs must not crash the backend. */
export interface Ignored<S> extends Transition<S, never> {
  readonly ignored: string;
}

export const to = <S, C = never>(state: S, ...commands: C[]): Transition<S, C> => ({ state, commands });
export const ignore = <S>(state: S, why: string): Ignored<S> => ({ state, commands: [], ignored: why });
