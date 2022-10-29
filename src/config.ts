export type Node = number;

export enum VoteType {
    YesNo = 'yn',
    YesNoBlank = 'ynb',
    RankedPairs = 'rp',
    SingleTransferableVote = 'stv',
    ThresholdMajority = 'tm',
}

export type Rational = number | [number, number];

export interface ConfigQuorum {
    quorum: Rational;
    quorumInclusive: boolean;
}

export interface ConfigBlank {
    blankBallotsLimit: Rational;
    blankBallotsLimitInclusive: boolean;
}

export interface ConfigMajority {
    majorityBallots: Rational;
    majorityBallotsInclusive: boolean;
    majorityVoters: Rational;
    majorityVotersInclusive: boolean;
    majorityMustReachBoth: boolean;
}

export interface ConfigMaxChoices {
    numChosenOptions: number;
}

export interface ConfigMentions {
    mentionThreshold: Rational;
    mentionThresholdInclusive: boolean;
}

export interface ConfigYesNo extends ConfigQuorum, ConfigMajority {
    type: VoteType.YesNo;
}
export interface ConfigYesNoBlank extends ConfigQuorum, ConfigBlank, ConfigMajority {
    type: VoteType.YesNoBlank;
}
export interface ConfigThresholdMajority extends ConfigQuorum, ConfigBlank, ConfigMaxChoices, ConfigMentions {
    type: VoteType.ThresholdMajority;
}
export interface ConfigRankedPairs extends ConfigQuorum, ConfigBlank, ConfigMaxChoices, ConfigMentions {
    type: VoteType.RankedPairs;
}
export interface ConfigSingleTransferableVote extends ConfigQuorum, ConfigBlank, ConfigMaxChoices {
    type: VoteType.SingleTransferableVote;
}

export type ConfigAny = ConfigYesNo | ConfigYesNoBlank | ConfigThresholdMajority | ConfigRankedPairs | ConfigSingleTransferableVote;

export interface BallotCounts {
    count: number;
    blank: number;
    voters: number;
}

export interface BallotMentions<N> {
    mentions: Map<N, number>;
    includedByMentions: N[];
    excludedByMentions: N[];
}

/** counts truly blank ballots */
export function countBlanks(ballots: ArrayBuffer): number {
    const ballots32 = new Uint32Array(ballots);
    const ballotCount = ballots32[0];
    let blanks = 0;

    for (let i = 0; i < ballotCount; i++) {
        const ballotIndex = ballots32[i + 1];
        const nextBallotIndex = ballots32[i + 2];
        if (ballotIndex === nextBallotIndex) {
            // a blank ballot has zero size
            blanks++;
        }
    }

    return blanks;
}

function rationalToNumber(r: Rational): number {
    if (Array.isArray(r)) return r[0] / r[1];
    return r;
}

export function passesThreshold(r: Rational, inclusive: boolean, value: Rational): boolean {
    if (inclusive) {
        return rationalToNumber(value) >= rationalToNumber(r);
    }
    return rationalToNumber(value) > rationalToNumber(r);
}

/** returns true if the ballot counts pass the quorum check as specified by the configuration */
export function passesQuorumCheck(config: ConfigQuorum, ballots: BallotCounts): boolean {
    return passesThreshold(config.quorum, config.quorumInclusive, ballots.count / ballots.voters);
}

/** returns true if the ballot counts pass the blank ballot limit check as specified by the configuration */
export function passesBlankCheck(config: ConfigBlank, ballots: BallotCounts): boolean {
    return !passesThreshold(config.blankBallotsLimit, config.blankBallotsLimitInclusive, ballots.blank / ballots.count);
}

export function candidateMentions(ballots: ArrayBuffer): Map<Node, number> {
    const ballots32 = new Uint32Array(ballots);
    const ballotCount = ballots32[0];
    const mentionsStart = ballots32[ballotCount + 1] / Uint32Array.BYTES_PER_ELEMENT;
    const tally = new Map();
    for (let i = mentionsStart; i < ballots32.length; i += 2) {
        const candidate = ballots32[i];
        const count = ballots32[i + 1];
        tally.set(candidate, count);
    }
    return tally;
}

export function filterCandidatesByMentions(config: ConfigMentions, candidates: Node[], ballots: ArrayBuffer): BallotMentions<Node> {
    const ballotCount = new Uint32Array(ballots)[0];
    const mentions = candidateMentions(ballots);
    const included = [];
    const excluded = [];

    for (const candidate of candidates) {
        const count = mentions.get(candidate) || 0;
        if (passesThreshold(config.mentionThreshold, config.mentionThresholdInclusive, count / ballotCount)) {
            included.push(candidate);
        } else {
            excluded.push(candidate);
        }
    }

    return {
        mentions,
        includedByMentions: included,
        excludedByMentions: excluded,
    };
}
