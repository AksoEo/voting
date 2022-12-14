import { ConfigYesNo, ConfigYesNoBlank, passesThreshold, countBlanks, candidateMentions } from './config';

/** “no” value of encoded ballots */
export const YNB_NO = 1;
/** “yes” value of encoded ballots */
export const YNB_YES = 2;

/** yes/no vote output */
export interface YnData {
    tally: {
        yes: number,
        no: number,
        blank: number,
    },
    pass: {
        /** whether the entire vote passed, according to the configured criteria (`majorityMustReachBoth`) */
        result: boolean,
        /** whether the majority of ballots voted yes, according to the configured threshold */
        majority: boolean,
        /** whether the majority of eligible voters voted yes, according to the configured threshold */
        voters: boolean,
    },
};

export function yesNo(config: ConfigYesNo | ConfigYesNoBlank, ballots: ArrayBuffer, eligibleVoters: number): YnData {
    const ballots32 = new Uint32Array(ballots);
    const ballotCount = ballots32[0];

    const blankCount = countBlanks(ballots);
    const tally = candidateMentions(ballots);

    const noCount = tally.get(YNB_NO) || 0;
    const yesCount = tally.get(YNB_YES) || 0;

    const passesMajority = passesThreshold(config.majorityBallots, config.majorityBallotsInclusive, yesCount / ballotCount);
    const passesVoters = passesThreshold(config.majorityVoters, config.majorityVotersInclusive, yesCount / eligibleVoters);

    const passes = config.majorityMustReachBoth ? passesMajority && passesVoters : passesMajority || passesVoters;

    return {
        tally: {
            yes: yesCount,
            no: noCount,
            blank: blankCount,
        },
        pass: {
            result: passes,
            majority: passesMajority,
            voters: passesVoters,
        },
    };
}
