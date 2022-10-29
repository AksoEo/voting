import { ConfigYesNo, ConfigYesNoBlank, passesThreshold, countBlanks } from './config';

export const YNB_NO = 1;
export const YNB_YES = 2;

export interface YnData {
    tally: {
        yes: number,
        no: number,
        blank: number,
    },
    pass: {
        result: boolean,
        majority: boolean,
        voters: boolean,
    },
};

export function yesNo(config: ConfigYesNo | ConfigYesNoBlank, ballots: ArrayBuffer, eligibleVoters: number): YnData {
    const ballots32 = new Uint32Array(ballots);
    const ballotCount = ballots32[0];

    const blankCount = countBlanks(ballots);

    const mentionsStart = ballots32[ballotCount + 1] / Uint32Array.BYTES_PER_ELEMENT;
    const tally = new Map();
    for (let i = mentionsStart; i < ballots32.length; i += 2) {
        const value = ballots32[i];
        const count = ballots32[i + 1];
        tally.set(value, count);
    }

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
