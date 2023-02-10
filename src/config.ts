export type Node = number;

export enum VoteType {
    YesNo = 'yn',
    YesNoBlank = 'ynb',
    RankedPairs = 'rp',
    SingleTransferableVote = 'stv',
    ThresholdMajority = 'tm',
}

/** either a float or a fraction of two numbers */
export type Rational = number | [number, number];

/** quorum component in vote config. a vote will only pass if at least <quorum>% voters submit a ballot */
export interface ConfigQuorum {
    quorum: Rational;
    quorumInclusive: boolean;
}

/** blank ballot limit component in vote config. a vote will only pass if fewer than <blankBallotsLimit>% ballots are blank */
export interface ConfigBlank {
    blankBallotsLimit: Rational;
    blankBallotsLimitInclusive: boolean;
}

/** YNB config */
export interface ConfigMajority {
    /** amount of ballots that must say yes for the result to be yes */
    majorityBallots: Rational;
    majorityBallotsInclusive: boolean;
    /** amount of voters that must say yes for the result to be yes */
    majorityVoters: Rational;
    majorityVotersInclusive: boolean;
    /** whether both of the above must have a “yes” result for the result to be yes */
    majorityMustReachBoth: boolean;
}

/** max choices in vote config */
export interface ConfigMaxChoices {
    numChosenOptions: number;
}

/** mention threshold in vote config */
export interface ConfigMentions {
    mentionThreshold: Rational;
    mentionThresholdInclusive: boolean;
}

/** configuration type for yes/no votes */
export interface ConfigYesNo extends ConfigQuorum, ConfigMajority {
    type: VoteType.YesNo;
}
/** configuration type for yes/no/blank votes */
export interface ConfigYesNoBlank extends ConfigQuorum, ConfigBlank, ConfigMajority {
    type: VoteType.YesNoBlank;
}
/** configuration type for threshold majority votes */
export interface ConfigThresholdMajority extends ConfigQuorum, ConfigBlank, ConfigMaxChoices, ConfigMentions {
    type: VoteType.ThresholdMajority;
}
/** configuration type for ranked pairs votes */
export interface ConfigRankedPairs extends ConfigQuorum, ConfigBlank, ConfigMaxChoices, ConfigMentions {
    type: VoteType.RankedPairs;
}
/** configuration type for single transferable vote votes */
export interface ConfigSingleTransferableVote extends ConfigQuorum, ConfigBlank, ConfigMaxChoices {
    type: VoteType.SingleTransferableVote;
}

/** configuration for any vote. union of all vote types */
export type ConfigAny = ConfigYesNo | ConfigYesNoBlank | ConfigThresholdMajority | ConfigRankedPairs | ConfigSingleTransferableVote;

/** contains information about ballots */
export interface BallotCounts {
    /** number of ballots in input */
    count: number;
    /** number of entirely blank ballots in input */
    blank: number;
    /** number of voters who could have submitted ballots */
    voters: number;
}

/** contains information about candidate mentions */
export interface BallotMentions<N> {
    /** number of mentions of each candidate */
    mentions: Map<N, number>;
    /** candidates included by the mention threshold. if there is no threshold, then this is all candidates */
    includedByMentions: N[];
    /** candidates excluded by the mention threshold. */
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

/** converts a Rational to a number; resolving any fractions */
function rationalToNumber(r: Rational): number {
    if (Array.isArray(r)) return r[0] / r[1];
    return r;
}

/** returns true if the value is greater than/greater-equal to a threshold given by an (r, inclusive) pair. */
export function passesThreshold(r: Rational, inclusive: boolean, value: Rational): boolean {
    if (inclusive) {
        return rationalToNumber(value) >= rationalToNumber(r);
    }
    return rationalToNumber(value) > rationalToNumber(r);
}

/** returns true if the value is less than/less-equal to a threshold given by an (r, inclusive) pair. */
export function withinThreshold(r: Rational, inclusive: boolean, value: Rational): boolean {
    if (inclusive) {
        return rationalToNumber(value) <= rationalToNumber(r);
    }
    return rationalToNumber(value) < rationalToNumber(r);
}

/** returns true if the ballot counts pass the quorum check as specified by the configuration */
export function passesQuorumCheck(config: ConfigQuorum, ballots: BallotCounts): boolean {
    return passesThreshold(config.quorum, config.quorumInclusive, ballots.count / ballots.voters);
}

/** returns true if the ballot counts pass the blank ballot limit check as specified by the configuration */
export function passesBlankCheck(config: ConfigBlank, ballots: BallotCounts): boolean {
    return withinThreshold(config.blankBallotsLimit, config.blankBallotsLimitInclusive, ballots.blank / ballots.count);
}

/** extracts candidate mentions from a ballot buffer */
export function candidateMentions(ballots: ArrayBuffer): Map<Node, number> {
    const ballots32 = new Uint32Array(ballots);
    const ballotCount = ballots32[0];
    const mentionsStart = Math.ceil(ballots32[ballotCount + 1] / Uint32Array.BYTES_PER_ELEMENT);
    const tally = new Map();
    for (let i = mentionsStart; i < ballots32.length; i += 2) {
        const candidate = ballots32[i];
        const count = ballots32[i + 1];
        tally.set(candidate, count);
    }
    return tally;
}

/** filters candidates by a mention threshold */
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
