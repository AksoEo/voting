import { Node } from './config';

export enum TmStatus {
    Success = 'success',
    TieBreakerNeeded = 'tie-breaker-needed',
    IncompleteTieBreaker = 'incomplete-tie-breaker',
}

export type TmResult<T, N> = {
    status: TmStatus.Success,
    value: T,
} | {
    status: TmStatus.TieBreakerNeeded,
    tiedNodes: N[],
} | {
    status: TmStatus.IncompleteTieBreaker,
    missing: N[],
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
    } else if (data.status === TmStatus.TieBreakerNeeded) {
        return { status: data.status, tiedNodes: data.tiedNodes.map(remap) };
    } else if (data.status === TmStatus.IncompleteTieBreaker) {
        return { status: data.status, missing: data.missing.map(remap) };
    }
}

/**
 * Runs a UEA threshold majority vote. Voters may elect multiple candidates, and all candidates are weighted equally.
 * The candidates with the most votes will be chosen.
 */
export function thresholdMajority(maxWinners: number, candidates: Node[], ballots: ArrayBuffer, tieBreaker: Node[] | null): TmResult<TmData<Node>, Node> {
    const ballots32 = new Uint32Array(ballots);

    const tally = new Map<Node, number>();

    const ballotCount = ballots32[0];
    const mentionsStart = ballots32[1 + ballotCount] / Uint32Array.BYTES_PER_ELEMENT;
    for (let i = mentionsStart; i < ballots32.length; i += 2) {
        const candidate = ballots32[i];
        const mentions = ballots32[i + 1];
        tally.set(candidate, mentions);
    }

    const sortedCandidates = candidates.slice().sort((a, b) => {
        const aMentions = tally.get(a) || 0;
        const bMentions = tally.get(b) || 0;
        return aMentions - bMentions;
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

        if (!tieBreaker) {
            return {
                status: TmStatus.TieBreakerNeeded,
                tiedNodes: ambiguousCandidates,
            };
        }

        // collect all the items we encounter that are missing from the tie breaker
        const missingTieBreakerItems = new Set<Node>();

        candidates.sort((a, b) => {
            const leftIndex = tieBreaker.indexOf(a);
            const rightIndex = tieBreaker.indexOf(b);

            if (leftIndex === -1 || rightIndex === -1) {
                missingTieBreakerItems.add(a);
                missingTieBreakerItems.add(b);
                return 0;
            }

            // sort with ascending index
            return leftIndex - rightIndex;
        });

        if (missingTieBreakerItems.size) {
            return {
                status: TmStatus.IncompleteTieBreaker,
                missing: [...missingTieBreakerItems],
            };
        }

        // cut to max length
        sortedCandidates.splice(maxWinners);
        // remove the ambiguous candidates
        for (const candidate of ambiguousCandidates) {
            const index = sortedCandidates.indexOf(candidate);
            if (index !== -1) sortedCandidates.splice(index, 1);
        }
        // add them back, this time in sorted order
        for (const candidate of ambiguousCandidates) {
            sortedCandidates.push(candidate);
        }
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
