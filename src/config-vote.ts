import {
    BallotCounts,
    BallotMentions,
    countBlanks,
    candidateMentions,
    filterCandidatesByMentions,
    Node,
    passesBlankCheck,
    passesQuorumCheck,
    ConfigAny,
    VoteType,
} from './config';
import { yesNo, YNB_NO, YNB_YES, YnData } from './yes-no';
import { thresholdMajority, TmData, TmStatus, remapTmData } from './threshold-majority';
import { rankedPairs, RpData, RpStatus, remapRpData } from './ranked-pairs';
import { singleTransferableVote, StvData, StvStatus, remapStvData } from './single-transferable-vote';
import { BallotEncoder } from './ballots';

/** Possible vote outcomes. */
export enum VoteStatus {
    /** Vote succeeded with a result */
    Success = 'success',
    /** The vote requires a tie breaker */
    TieBreakerNeeded = 'tie-breaker-needed',
    /** The tie breaker does not contain the requested items */
    IncompleteTieBreaker = 'incomplete-tie-breaker',
    /** The majority of ballots did not contain enough candidates */
    MajorityEmpty = 'majority-empty',

    /** Too few eligible voters submitted a ballot */
    NoQuorum = 'no-quorum',
    /** Too many entirely blank ballots */
    TooManyBlanks = 'too-many-blanks',
}

// vote result components

// VoteStatus.Success
interface TaggedYnSuccess {
    type: VoteType.YesNo | VoteType.YesNoBlank;
    status: VoteStatus.Success;
    ballots: BallotCounts;
    value: YnData;
}
interface TaggedSuccess<T, N, D> {
    type: T;
    status: VoteStatus.Success;
    ballots: BallotCounts;
    mentions: BallotMentions<N>;
    value: D;
}
type TaggedTmSuccess<N> = TaggedSuccess<VoteType.ThresholdMajority, N, TmData<N>>;
type TaggedRpSuccess<N> = TaggedSuccess<VoteType.RankedPairs, N, RpData<N>>;
type TaggedStvSuccess<N> = TaggedSuccess<VoteType.SingleTransferableVote, N, StvData<N>>;
type TaggedAnySuccess<N> = TaggedYnSuccess | TaggedTmSuccess<N> | TaggedRpSuccess<N> | TaggedStvSuccess<N>;

// VoteStatus.TieBreakerNeeded
interface TaggedTmStvTieBreakerNeeded<N> {
    type: VoteType.ThresholdMajority | VoteType.SingleTransferableVote;
    ballots: BallotCounts;
    mentions: BallotMentions<N>;
    status: VoteStatus.TieBreakerNeeded;
    tiedNodes: N[];
}
interface TaggedRpTieBreakerNeeded<N> {
    type: VoteType.RankedPairs;
    ballots: BallotCounts;
    mentions: BallotMentions<N>;
    status: VoteStatus.TieBreakerNeeded;
    pairs: [N, N][];
}
type TaggedTieBreakerNeeded<N> = TaggedTmStvTieBreakerNeeded<N> | TaggedRpTieBreakerNeeded<N>;

// VoteStatus.IncompleteTieBreaker
interface TaggedIncompleteTieBreaker<N> {
    type: VoteType.ThresholdMajority | VoteType.RankedPairs | VoteType.SingleTransferableVote;
    status: VoteStatus.IncompleteTieBreaker;
    ballots: BallotCounts;
    mentions: BallotMentions<N>;
    missing: N[];
}

// VoteStatus.MajorityEmpty
interface TaggedMajorityEmpty<N> {
    type: VoteType.ThresholdMajority | VoteType.RankedPairs | VoteType.SingleTransferableVote;
    ballots: BallotCounts;
    mentions: BallotMentions<N>;
    status: VoteStatus.MajorityEmpty;
}

// VoteStatus.NoQuorum
interface TaggedNoQuorum {
    type: VoteType;
    status: VoteStatus.NoQuorum;
    ballots: BallotCounts;
}

// VoteStatus.TooManyBlanks
interface TaggedTooManyBlanks {
    type: VoteType;
    status: VoteStatus.TooManyBlanks;
    ballots: BallotCounts;
}

/**
 * a vote result. union of all possible result statuses.
 */
export type VoteResult<N> = TaggedAnySuccess<N> | TaggedTieBreakerNeeded<N> | TaggedIncompleteTieBreaker<N>
    | TaggedMajorityEmpty<N> | TaggedNoQuorum | TaggedTooManyBlanks;

function remapMentions<N, M>(mentions: BallotMentions<N>, remap: (node: N) => M): BallotMentions<M> {
    return {
        mentions: new Map([...mentions.mentions.entries()].map(([k, v]) => [remap(k), v])),
        includedByMentions: mentions.includedByMentions.map(remap),
        excludedByMentions: mentions.excludedByMentions.map(remap),
    };
}

/** remaps a vote result from one candidate type to another with a remapping function. */
function remapResult<N, M>(result: VoteResult<N>, remap: (node: N) => M): VoteResult<M> {
    if (result.status === VoteStatus.Success) {
        if (result.type === VoteType.YesNo || result.type == VoteType.YesNoBlank) {
            return result;
        } else if (result.type === VoteType.ThresholdMajority
            || result.type === VoteType.RankedPairs
            || result.type === VoteType.SingleTransferableVote) {
            const mentions = remapMentions(result.mentions, remap);

            if (result.type === VoteType.ThresholdMajority) {
                const value = remapTmData(result.value, remap);
                return { ...result, mentions, value };
            } else if (result.type === VoteType.RankedPairs) {
                const value = remapRpData(result.value, remap);
                return { ...result, mentions, value };
            } else if (result.type === VoteType.SingleTransferableVote) {
                const value = remapStvData(result.value, remap);
                return { ...result, mentions, value };
            }
        }
    } else if (result.status === VoteStatus.TieBreakerNeeded) {
        if (result.type === VoteType.RankedPairs) {
            const mentions = remapMentions(result.mentions, remap);
            const pairs = result.pairs.map(([a, b]) => [remap(a), remap(b)] as [M, M]);
            return { ...result, mentions, pairs };
        } else {
            const mentions = remapMentions(result.mentions, remap);
            const tiedNodes = result.tiedNodes.map(remap);
            return { ...result, mentions, tiedNodes };
        }
    } else if (result.status === VoteStatus.IncompleteTieBreaker) {
        const mentions = remapMentions(result.mentions, remap);
        const missing = result.missing.map(remap);
        return { ...result, mentions, missing };
    } else if (result.status === VoteStatus.MajorityEmpty) {
        const mentions = remapMentions(result.mentions, remap);
        return { ...result, mentions };
    } else {
        // other status types contains no candidates
        return result;
    }
}

/**
 * Runs a vote according to the configuration, with numeric candidate values.
 *
 * Parameters:
 *
 * - `config`: a vote configuration. see type definition and AKSO API `Vote` schema for further details
 * - `ballots`: ballots encoded with a `BallotEncoder`
 *   YesNo or YesNoBlank votes must have ballots with a value of YNB_NO for no and YNB_YES for yes
 * - `eligibleVoters`: number of eligible voters
 * - `candidates`: list of candidates. candidate values must be positive and nonzero.
 *   only applicable to ThresholdMajority, RankedPairs, SingleTransferableVote.
 * - `tieBreaker`: an optional tie-breaker ballot that unambiguously orders candidates.
 *   only applicable to ThresholdMajority, RankedPairs, SingleTransferableVote.
 */
export function runConfigVote(
    config: ConfigAny,
    ballots: ArrayBuffer,
    eligibleVoters: number,
    candidates: Node[],
    tieBreaker?: Node[],
): VoteResult<Node> {
    const ballotCount = new Uint32Array(ballots)[0];
    const blanks = countBlanks(ballots);

    const ballotCounts: BallotCounts = {
        count: ballotCount,
        blank: blanks,
        voters: eligibleVoters,
    };

    if (!passesQuorumCheck(config, ballotCounts)) {
        return {
            type: config.type,
            status: VoteStatus.NoQuorum,
            ballots: ballotCounts,
        };
    }

    if (config.type !== VoteType.YesNo && !passesBlankCheck(config, ballotCounts)) {
        return {
            type: config.type,
            status: VoteStatus.TooManyBlanks,
            ballots: ballotCounts,
        };
    }

    // YNB is trivial and does not use mentions
    if (config.type === VoteType.YesNo || config.type === VoteType.YesNoBlank) {
        const value = yesNo(config, ballots, eligibleVoters);
        return {
            type: config.type,
            status: VoteStatus.Success,
            ballots: ballotCounts,
            value,
        };
    }

    // all other vote types include mentions in output
    let filteredCandidates = candidates;
    let mentions: BallotMentions<Node> = {
        mentions: new Map(),
        includedByMentions: candidates,
        excludedByMentions: [],
    };
    if (config.type === VoteType.ThresholdMajority || config.type === VoteType.RankedPairs) {
        mentions = filterCandidatesByMentions(config, candidates, ballots);
        filteredCandidates = mentions.includedByMentions;
    } else {
        mentions.mentions = candidateMentions(ballots);
    }

    // there should be at least one candidate mentioned in ballots; otherwise we can’t elect anyone at all
    let minFilteredCandidates = 1;
    if (config.type === VoteType.RankedPairs) {
        // need at least 2 candidates to have a pair!
        minFilteredCandidates = 2;
    }

    if (filteredCandidates.length < minFilteredCandidates) {
        // too few candidates mentioned; no meaningful election
        return {
            type: config.type,
            status: VoteStatus.MajorityEmpty,
            ballots: ballotCounts,
            mentions,
        };
    }

    // run vote and convert to VoteResult
    if (config.type === VoteType.ThresholdMajority) {
        const result = thresholdMajority(config.numChosenOptions, mentions.includedByMentions, ballots, tieBreaker);
        if (result.status === TmStatus.Success) {
            return {
                type: config.type,
                status: VoteStatus.Success,
                ballots: ballotCounts,
                mentions,
                value: result.value,
            };
        } else if (result.status === TmStatus.TieBreakerNeeded) {
            return {
                type: config.type,
                status: VoteStatus.TieBreakerNeeded,
                ballots: ballotCounts,
                mentions,
                tiedNodes: result.tiedNodes,
            };
        } else if (result.status === TmStatus.IncompleteTieBreaker) {
            return {
                type: config.type,
                status: VoteStatus.IncompleteTieBreaker,
                ballots: ballotCounts,
                mentions,
                missing: result.missing,
            };
        }
    } else if (config.type === VoteType.RankedPairs) {
        const result = rankedPairs(config.numChosenOptions, mentions.includedByMentions, ballots, tieBreaker);
        if (result.status === RpStatus.Success) {
            return {
                type: config.type,
                status: VoteStatus.Success,
                ballots: ballotCounts,
                mentions,
                value: result.value,
            };
        } else if (result.status === RpStatus.TieBreakerNeeded) {
            return {
                type: config.type,
                status: VoteStatus.TieBreakerNeeded,
                ballots: ballotCounts,
                mentions,
                pairs: result.pairs,
            };
        } else if (result.status === RpStatus.IncompleteTieBreaker) {
            return {
                type: config.type,
                status: VoteStatus.IncompleteTieBreaker,
                ballots: ballotCounts,
                mentions,
                missing: result.missing,
            };
        } else if (result.status === RpStatus.MajorityEmpty) {
            return {
                type: config.type,
                status: VoteStatus.MajorityEmpty,
                ballots: ballotCounts,
                mentions,
            };
        }
    } else if (config.type === VoteType.SingleTransferableVote) {
        const result = singleTransferableVote(config.numChosenOptions, mentions.includedByMentions, ballots, tieBreaker);
        if (result.status === StvStatus.Success) {
            return {
                type: config.type,
                status: VoteStatus.Success,
                ballots: ballotCounts,
                mentions,
                value: result.value,
            };
        } else if (result.status === StvStatus.TieBreakerNeeded) {
            return {
                type: config.type,
                status: VoteStatus.TieBreakerNeeded,
                ballots: ballotCounts,
                mentions,
                tiedNodes: result.tiedNodes,
            };
        } else if (result.status === StvStatus.IncompleteTieBreaker) {
            return {
                type: config.type,
                status: VoteStatus.IncompleteTieBreaker,
                ballots: ballotCounts,
                mentions,
                missing: result.missing,
            };
        }
    }
}

/**
 * Runs a vote according to the configuration, with arbitrary candidate values.
 *
 * Additional notes:
 *
 * - candidate values must be `==`-comparable.
 *
 * Parameters:
 *
 * - `config`: a vote configuration. see type definition and AKSO API `Vote` schema for further details
 * - `ballots`: all ballots in an array.
 *   YesNo or YesNoBlank votes must have ballots with a value of YNB_NO for no and YNB_YES for yes.
 *   any candidates in a ballot not listed in `candidates` will be ignored.
 * - `eligibleVoters`: number of eligible voters
 * - `candidates`: list of candidates.
 *   for YesNo or YesNoBlank votes, this must be a 2-element array containing [ballot value of no, ballot value of yes]
 *   (e.g. `['n', 'y']`).
 *   any type is accepted for candidates as long as it’s `==`-comparable.
 * - `tieBreaker`: an optional tie-breaker ballot that unambiguously orders candidates.
 *   only applicable to ThresholdMajority, RankedPairs, SingleTransferableVote.
 */
export function runMappedConfigVote<N>(
    config: ConfigAny,
    ballots: (N | N[])[][],
    eligibleVoters: number,
    candidates: N[],
    tieBreaker?: N[],
): VoteResult<N> {
    const remappedCandidates = new Map<N, Node>();
    const unmappedCandidates = new Map<Node, N>();

    if (config.type === VoteType.YesNo || config.type === VoteType.YesNoBlank) {
        if (candidates.length !== 2) throw new Error('YNB vote must have 2 candidates (no, yes)');
        remappedCandidates.set(candidates[0], YNB_NO);
        unmappedCandidates.set(YNB_NO, candidates[0]);
        remappedCandidates.set(candidates[1], YNB_YES);
        unmappedCandidates.set(YNB_YES, candidates[1]);
    } else {
        let candidateId = 1;
        for (const cand of candidates) {
            const id = candidateId++;
            remappedCandidates.set(cand, id);
            unmappedCandidates.set(id, cand);
        }
    }

    const encoder = new BallotEncoder(ballots.length);
    for (const ballot of ballots) {
        let encodedBallot = [];
        for (const rank of ballot) {
            if (Array.isArray(rank)) {
                const encodedRank = [];
                for (const item of rank) {
                    if (remappedCandidates.has(item)) {
                        encodedRank.push(remappedCandidates.get(item));
                    }
                }
                if (encodedRank.length) encodedBallot.push(encodedRank);
            } else if (remappedCandidates.has(rank)) {
                encodedBallot.push(remappedCandidates.get(rank));
            }
        }
        encoder.addBallot(encodedBallot);
    }
    const encodedBallots = encoder.finish();

    let encodedTieBreaker = null;
    if (tieBreaker) {
        encodedTieBreaker = [];
        for (const item of tieBreaker) {
            if (remappedCandidates.has(item)) {
                encodedTieBreaker.push(remappedCandidates.get(item));
            }
        }
    }

    const result = runConfigVote(config, encodedBallots, eligibleVoters, [...remappedCandidates.values()], encodedTieBreaker);
    return remapResult(result, id => unmappedCandidates.get(id));
}