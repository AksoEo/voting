export type Node = number;

export enum StvStatus {
    Success = 'success',
    TieBreakerNeeded = 'tie-breaker-needed',
    IncompleteTieBreaker = 'incomplete-tie-breaker',
}

export type StvResult<T> = {
    status: StvStatus.Success;
    value: T;
} | {
    status: StvStatus.TieBreakerNeeded;
    tiedNodes: Node[];
} | {
    status: StvStatus.IncompleteTieBreaker;
    missing: Node[];
};

export interface StvData {
    winners: Node[];
    events: StvEvent[];
}

export enum StvEventType {
    /** candidates were elected using the quota */
    ElectWithQuota = 'elect-with-quota',
    /** candidates were elected because we ran out of candidates */
    ElectRest = 'elect-rest',
    /** a candidate was eliminated */
    Eliminate = 'eliminate',
}

export type StvEvent = {
    type: StvEventType.ElectWithQuota,
    elected: Node[],
    values: Map<Node, number>,
    quota: number,
} | {
    type: StvEventType.ElectRest,
    elected: Node[],
} | {
    type: StvEventType.Eliminate,
    candidate: Node,
    values: Map<Node, number>,
};

type Ballots16 = Uint16Array;

type BallotCallback = (ballots: Ballots16, startIndex: number, endIndex: number) => void;
/** calls a function on each ballot */
function forAllBallots(ballots: ArrayBuffer, closure: BallotCallback) {
    const ballots32 = new Uint32Array(ballots);
    const ballots16 = new Uint16Array(ballots);

    const ballotCount = ballots32[0];

    for (let i = 0; i < ballotCount; i++) {
        const ballotStart = ballots32[i + 1];
        let ballotEnd = ballots.byteLength;
        if (i < ballotCount - 1) ballotEnd = ballots32[i + 2];

        closure(ballots16, ballotStart / Uint16Array.BYTES_PER_ELEMENT, ballotEnd / Uint16Array.BYTES_PER_ELEMENT);
    }
}

/**
 * reads n-th preference of every ballot into a Map<candidate, count> tally.
 * optionally saves each ballot’s n-th preference into an output array.
 */
function scanNthPreferences(ballots: ArrayBuffer, candidates: Set<Node>, n: number, output?: Uint16Array): Map<Node, number> {
    const nthPreferences = new Map<Node, number>();
    let ballotIndex = 0;
    forAllBallots(ballots, (ballots, start, end) => {
        // count higher preferences until we arrive at n
        let higherPreferences = 0;
        let nthPreference = null;
        for (let i = start; i < end; i++) {
            const value = ballots[i];
            if (candidates.has(value)) {
                if (higherPreferences >= n) {
                    nthPreference = value;
                    break;
                } else {
                    higherPreferences++;
                }
            }
            i++;
        }

        if (nthPreference) {
            const currentCount = nthPreferences.get(nthPreference) || 0;
            nthPreferences.set(nthPreference, currentCount + 1);
            if (output) output[ballotIndex++] = nthPreference;
        } else if (output) {
            output[ballotIndex++] = 0;
        }
    });
    return nthPreferences;
}

/**
 * reads the candidate that came after the given candidate in each ballot, and saves it into the output array.
 * also returns a tally.
 */
function scanNextPreferences(ballots: ArrayBuffer, candidates: Set<Node>, givenCandidate: Node, output: Uint16Array): Map<Node, number> {
    const nextPreferences = new Map<Node, number>();
    let ballotIndex = 0;
    forAllBallots(ballots, (ballots, start, end) => {
        let hasGivenCandidate = false;
        let nextPreference = null;
        for (let i = start; i < end; i++) {
            const value = ballots[i];
            if (value === givenCandidate) {
                hasGivenCandidate = true;
            } else if (hasGivenCandidate && candidates.has(value)) {
                nextPreference = value;
                break;
            }
        }

        if (nextPreference) {
            const currentCount = nextPreferences.get(nextPreference) || 0;
            nextPreferences.set(nextPreference, currentCount + 1);
            output[ballotIndex++] = nextPreference;
        } else {
            output[ballotIndex++] = 0;
        }
    });
    return nextPreferences;
}

type VotesPerCandidate = Map<Node, number>;

/**
 * the Gregory method transfers fractional votes to next-preference candidates.
 * hence we need to keep track of the fractional value of each ballot, on each candidate.
 * this will create a table like this
 *             | ballot 1 | ballot 2 | ballot 3 ⋯
 * ----------- + -------- + -------- + -------- ⋯
 * candidate 1 |     0.25 |      1.0 |      0.0 ⋯
 * candidate 2 |     0.75 |      0.0 |      1.0 ⋯
 *           ⋮ |        ⋮ |        ⋮ |        ⋮ ⋱
 * in which each ballot column must sum to 1, and each candidate rows sums to their vote value.
 * initially, all ballots are initialized to 1.0 on their first-preference candidate.
 */
class VoteValues {
    ballotCount: number;
    /** the table as outlined above */
    values = new Map<Node, Float64Array>();
    /** the row sum for each candidate */
    candValues: VotesPerCandidate = new Map();

    constructor(
        candidates: Set<Node>,
        firstPreferenceTally: Map<Node, number>,
        firstPreferenceAssignments: Uint16Array,
    ) {
        this.ballotCount = firstPreferenceAssignments.length;

        for (const cand of candidates) {
            const values = new Float64Array(this.ballotCount);
            values.fill(0.0);
            this.values.set(cand, values);
        }

        // we can just take the first preference tally for our row sum
        this.candValues = new Map(firstPreferenceTally);

        // set first preference cells to 1.0
        for (let i = 0; i < this.ballotCount; i++) {
            const firstPreferenceCand = firstPreferenceAssignments[i];
            if (firstPreferenceCand) {
                this.values.get(firstPreferenceCand)[i] = 1.0;
            }
        }
    }

    /** returns the total vote value of a candidate */
    getCandidateValue(candidate: Node) {
        return this.candValues.get(candidate);
    }

    /**
     * transfers fractional votes from one candidate to another.
     * `perVoteTransferAmount` is a value from 0 to 1 indicating how much to transfer.
     * use the `ballotFilter` to determine which ballots to transfer.
     */
    transferVotes(
        fromCandidate: Node,
        toCandidate: Node,
        perVoteTransferAmount: number,
        ballotFilter: (index: number) => boolean,
    ) {
        const fromCandValues = this.values.get(fromCandidate);
        const toCandValues = this.values.get(toCandidate);

        let totalTransferredAmount = 0;
        for (let i = 0; i < this.ballotCount; i++) {
            const currentValue = fromCandValues[i];
            if (!currentValue) continue; // zero ballot has no effect
            if (!ballotFilter(i)) continue;

            const transferredAmount = currentValue * perVoteTransferAmount;

            fromCandValues[i] = currentValue - transferredAmount;
            toCandValues[i] += transferredAmount
            totalTransferredAmount += transferredAmount;
        }

        // transfer totals
        this.candValues.set(fromCandidate, (this.candValues.get(fromCandidate) || 0) - totalTransferredAmount);
        this.candValues.set(toCandidate, (this.candValues.get(toCandidate) || 0) + totalTransferredAmount);
    }
}

/** returns a list of all candidates that have the minimum amount of votes */
function findCandidatesWithFewestVotes(candidates: Set<Node>, voteCounts: VotesPerCandidate): Node[] {
    let smallestVoteCount = Infinity;
    for (const cand of candidates) {
        const value = voteCounts.get(cand) || 0;
        if (value < smallestVoteCount) smallestVoteCount = value;
    }

    return [...candidates]
        .map(cand => [cand, voteCounts.get(cand) || 0])
        .filter(([, count]) => count <= smallestVoteCount)
        .map(([cand, _]) => cand);
}

/** sorts candidates using the tie breaker ballot. highest index will be least preferred. */
function sortByTieBreaker(candidates: Node[], tieBreaker: Node[]): StvResult<void> {
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
            status: StvStatus.IncompleteTieBreaker,
            missing: [...missingTieBreakerItems],
        };
    }

    return { status: StvStatus.Success, value: null };
}

/** elects all remaining candidates whose vote value exceeds the given fixed quota. returns all newly elected candidates */
function electUsingFixedQuota(
    remainingCandidates: Set<Node>,
    voteValues: VoteValues,
    fixedElectionQuota: number,
    maxWinners: number,
    tieBreaker: Node[] | null,
    electedCandidates: Set<Node>,
): StvResult<Node[]> {
    const newlyElected = [...remainingCandidates.values()]
        .map(candidate => [candidate, voteValues.getCandidateValue(candidate)])
        .filter(([, count]) => count > fixedElectionQuota)
        .sort(([, a], [, b]) => b - a) // sort descending
        .map(([candidate, _]) => candidate);

    if (electedCandidates.size + newlyElected.length > maxWinners) {
        // that’s too many! we need to remove some candidates!
        const maxNewlyElected = maxWinners - electedCandidates.size;
        const stillIncluded = newlyElected[maxNewlyElected - 1];
        const firstExcluded = newlyElected[maxNewlyElected];
        const stillIncludedValue = voteValues.getCandidateValue(stillIncluded);

        if (stillIncludedValue === voteValues.getCandidateValue(firstExcluded)) {
            // the first excluded candidate has the same number of votes as the last still included candidate.
            // this means that it’s ambiguous who would get excluded.
            // we’ll consult the tie breaker to find out who should get excluded

            const ambiguousCandidates = newlyElected
                .filter(candidate => voteValues.getCandidateValue(candidate) === stillIncludedValue);

            if (!tieBreaker) {
                return {
                    status: StvStatus.TieBreakerNeeded,
                    tiedNodes: ambiguousCandidates,
                };
            }

            const sortResult = sortByTieBreaker(ambiguousCandidates, tieBreaker);
            if (sortResult.status !== StvStatus.Success) {
                return sortResult as StvResult<Node[]>;
            }

            // cut newly elected to max length
            newlyElected.splice(maxNewlyElected);
            // remove the ambiguous candidates
            for (const candidate of ambiguousCandidates) {
                const index = newlyElected.indexOf(candidate);
                if (index !== -1) newlyElected.splice(index, 1);
            }
            // add them back, this time in sorted order
            for (const candidate of ambiguousCandidates) {
                newlyElected.push(candidate);
            }
            // cut again
            newlyElected.splice(maxNewlyElected);
        }
    }

    // elect candidates
    for (const cand of newlyElected) {
        electedCandidates.add(cand);
        remainingCandidates.delete(cand);
    }

    return { status: StvStatus.Success, value: newlyElected };
}

function findCandidateToEliminate(
    remainingCandidates: Set<Node>,
    originalCandidates: Set<Node>,
    originalBallots: ArrayBuffer,
    nthPreferences: VotesPerCandidate[],
    voteValues: VoteValues,
    tieBreaker: Node[],
): StvResult<Node> {
    let candidatesWithFewestVotes = findCandidatesWithFewestVotes(remainingCandidates, voteValues.candValues);

    // if there’s more than one candidate with the smallest vote count,
    // we need to go through all nth-preferences to find the ones with the fewest votes there
    let n = 0;
    while (candidatesWithFewestVotes.length > 1) {
        if (!nthPreferences[n]) {
            // we need to use the original candidate list since we want the original rankings
            nthPreferences[n] = scanNthPreferences(originalBallots, originalCandidates, n);
        }

        const counts = nthPreferences[n];
        if (!counts.size) {
            // empty! no ballot has anything listed this far down, so we should quit
            break;
        }
        candidatesWithFewestVotes = findCandidatesWithFewestVotes(remainingCandidates, counts);
        n++;
    }

    let candidateToEliminate;
    if (candidatesWithFewestVotes.length > 1) {
        // there’s still more than one candidate!
        // in this case, consult the tie breaker
        if (!tieBreaker) {
            return {
                status: StvStatus.TieBreakerNeeded,
                tiedNodes: candidatesWithFewestVotes,
            };
        }

        const sortResult = sortByTieBreaker(candidatesWithFewestVotes, tieBreaker);
        if (sortResult.status !== StvStatus.Success) {
            return sortResult as StvResult<Node>;
        }

        // highest index is least preferred
        candidateToEliminate = candidatesWithFewestVotes.pop();
    } else {
        candidateToEliminate = candidatesWithFewestVotes[0];
    }

    return { status: StvStatus.Success, value: candidateToEliminate };
}

export function singleTransferableVote(maxWinners: number, candidates: Node[], ballots: ArrayBuffer, tieBreaker: Node[] | null): StvResult<StvData> {
    if (maxWinners >= candidates.length) {
        // there aren’t enough candidates to have an actual meaningful election here (point 7)

        return {
            status: StvStatus.Success,
            value: {
                winners: [...candidates],
                events: [{
                    type: StvEventType.ElectRest,
                    elected: [...candidates],
                }],
            },
        };
    }
    maxWinners = Math.min(maxWinners, candidates.length);

    const ballotCount = new Uint32Array(ballots)[0];

    const electedCandidates = new Set<Node>();
    const originalCandidates = new Set(candidates);
    const remainingCandidates = new Set(originalCandidates);

    // read first preferences into assignments
    const firstPreferenceAssignments = new Uint16Array(ballotCount);
    const firstPreferences = scanNthPreferences(ballots, remainingCandidates, 0, firstPreferenceAssignments);
    const nthPreferences = [firstPreferences];

    // use first preferences as initial vote values
    const voteValues = new VoteValues(remainingCandidates, firstPreferences, firstPreferenceAssignments);

    const events: StvEvent[] = [];

    // Hagenbach-Bischoff quota (point 5)
    const fixedElectionQuota = ballotCount / (maxWinners + 1);

    // find all current first preferences who exceed the fixed quota (point 6)
    const quotaElectedResult = electUsingFixedQuota(remainingCandidates, voteValues, fixedElectionQuota, maxWinners, tieBreaker, electedCandidates);
    if (quotaElectedResult.status !== StvStatus.Success) return quotaElectedResult as StvResult<StvData>;
    let quotaElected = quotaElectedResult.value;
    events.push({
        type: StvEventType.ElectWithQuota,
        elected: quotaElected,
        values: new Map(voteValues.candValues),
        quota: fixedElectionQuota,
    });

    // allocate this only once (all values will be overwritten every time)
    const ballotNextPreferences = new Uint16Array(ballotCount);

    while (true) {
        if (electedCandidates.size + remainingCandidates.size <= maxWinners) {
            // if there aren’t enough candidates remaining to have a meaningful election, elect them all and quit (point 7)
            for (const cand of remainingCandidates) electedCandidates.add(cand);
            events.push({ type: StvEventType.ElectRest, elected: [...remainingCandidates] });

            break;
        }

        // transfer surplus votes to next preferences
        for (const electedCand of quotaElected) {
            const totalVoteValue = voteValues.getCandidateValue(electedCand);

            // surplus votes (votes above the quota that the candidate wouldn’t have needed to get elected) (point 8)
            const surplusVoteValue = totalVoteValue - fixedElectionQuota;

            // how much of each vote to transfer as a surplus (point 9)
            // (note that this is just the per-vote amount, without the multiplication by transferred votes in the spec)
            const perVoteTransferAmount = surplusVoteValue / totalVoteValue;

            const nextPreferences = scanNextPreferences(ballots, remainingCandidates, electedCand, ballotNextPreferences);
            for (const otherCand of nextPreferences.keys()) {
                voteValues.transferVotes(
                    electedCand,
                    otherCand,
                    perVoteTransferAmount,
                    i => ballotNextPreferences[i] === otherCand,
                );
            }
        }

        // elect again using fixed quota (point 10)
        const quotaElectedResult = electUsingFixedQuota(remainingCandidates, voteValues, fixedElectionQuota, maxWinners, tieBreaker, electedCandidates);
        if (quotaElectedResult.status !== StvStatus.Success) return quotaElectedResult as StvResult<StvData>;
        quotaElected = quotaElectedResult.value;
        events.push({
            type: StvEventType.ElectWithQuota,
            elected: quotaElected,
            values: new Map(voteValues.candValues),
            quota: fixedElectionQuota,
        });

        if (electedCandidates.size >= maxWinners) {
            // we're done!
            break;
        }

        while (!quotaElected.length && remainingCandidates.size) {
            // actually, no new candidates were elected, and there are still spaces to fill!
            // we now have to eliminate the option with the fewest votes (point 11)

            const eliminationResult = findCandidateToEliminate(
                remainingCandidates,
                originalCandidates,
                ballots,
                nthPreferences,
                voteValues,
                tieBreaker,
            );
            if (eliminationResult.status !== StvStatus.Success) {
                return eliminationResult as StvResult<StvData>;
            }
            const candidateToEliminate = eliminationResult.value;

            // eliminate!
            remainingCandidates.delete(candidateToEliminate);

            // transfer votes from eliminated candidate
            const nextPreferences = scanNextPreferences(ballots, remainingCandidates, candidateToEliminate, ballotNextPreferences);

            for (const otherCand of nextPreferences.keys()) {
                voteValues.transferVotes(
                    candidateToEliminate,
                    otherCand,
                    1.0, // transfer all of it
                    i => ballotNextPreferences[i] === otherCand,
                )
            }
            events.push({ type: StvEventType.Eliminate, candidate: candidateToEliminate, values: new Map(voteValues.candValues) });

            const quotaElectedResult = electUsingFixedQuota(remainingCandidates, voteValues, fixedElectionQuota, maxWinners, tieBreaker, electedCandidates);
            if (quotaElectedResult.status !== StvStatus.Success) return quotaElectedResult as StvResult<StvData>;
            quotaElected = quotaElectedResult.value;
            events.push({
                type: StvEventType.ElectWithQuota,
                elected: quotaElected,
                values: new Map(voteValues.candValues),
                quota: fixedElectionQuota,
            });

            if (electedCandidates.size >= maxWinners) {
                // we're done!
                break;
            }

            if (quotaElected.length) {
                // someone was elected this time! return to the top (point 13)
                break;
            }

            // otherwise, loop again. quotaElected is still empty, so we’ll need to eliminate another candidate (point 13)
        }
    }

    return {
        status: StvStatus.Success,
        value: {
            winners: [...electedCandidates],
            events,
        },
    };
}