import {candidateMentions, Node} from './config';

export enum TmStatus {
    Success = 'success',
    Tie = 'tie',
    IncompleteTieBreaker = 'incomplete-tie-breaker',
}

export type TmResult<T, N> = {
    status: TmStatus.Success,
    value: T,
} | {
    status: TmStatus.Tie,
    tiedNodes: N[],
    sortedNodes: N[],
};

/** threshold majority output */
export interface TmData<N> {
    winners: N[];
    tally: Map<N, number>;
}

// for converting form one candidate type to another
export function remapTmData<N, M>(data: TmData<N>, remap: (node: N) => M): TmData<M> {
    return {
        winners: data.winners.map(remap),
        tally: new Map([...data.tally.entries()].map(([k, v]) => [remap(k), v])),
    };
}

export function remapTmResult<N, M>(data: TmResult<TmData<N>, N>, remap: (node: N) => M): TmResult<TmData<M>, M> {
    if (data.status === TmStatus.Success) {
        return { status: data.status, value: remapTmData(data.value, remap) };
    } else if (data.status === TmStatus.Tie) {
        return {
            status: data.status,
            tiedNodes: data.tiedNodes.map(remap),
            sortedNodes: data.sortedNodes.map(remap),
        };
    }
}

/**
 * Runs a UEA threshold majority vote. Voters may elect multiple candidates, and all candidates are weighted equally.
 * The candidates with the most votes will be chosen.
 */
export function thresholdMajority(maxWinners: number, candidates: Node[], ballots: ArrayBuffer): TmResult<TmData<Node>, Node> {
    const tally = candidateMentions(ballots);

    // sort descending
    const sortedCandidates = candidates.slice().sort((a, b) => {
        const aMentions = tally.get(a) || 0;
        const bMentions = tally.get(b) || 0;
        return bMentions - aMentions;
    });

    // check if there’s a tie at the boundary and ambiguity about who should be elected
    const stillIncluded = sortedCandidates[maxWinners - 1];
    const firstExcluded = sortedCandidates[maxWinners];
    const stillIncludedValue = tally.get(stillIncluded);

    if (stillIncludedValue === tally.get(firstExcluded)) {
        // the first excluded candidate has the same number of votes as the last still included candidate.
        // this means that it’s ambiguous who would get excluded.
        // we’ll consult the tie breaker to find out who should get excluded

        const ambiguousCandidates = sortedCandidates
            .filter(candidate => tally.get(candidate) === stillIncludedValue);

        return {
            status: TmStatus.Tie,
            tiedNodes: ambiguousCandidates,
            sortedNodes: sortedCandidates,
        };
    }

    // cut off any non-elected candidates
    sortedCandidates.splice(maxWinners);

    return {
        status: TmStatus.Success,
        value: {
            winners: sortedCandidates,
            tally,
        },
    };
}
