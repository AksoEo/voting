import { BallotEncoder, rankedPairs, singleTransferableVote } from '../dist/index.mjs';
import { unordered, WHATEVER, whateverKeys, whateverRest, assertEq } from './utils.js';
import ReferenceRankedPairs from './rp-old.js';
import ReferenceSingleTransferableVote from './stv-old.js';

/** formats a ballot for printing */
function formatBallot(ballot) {
    return ballot.map(row => typeof row === 'number' ? row : row.join('=')).join('>');
}

/** formats ballots for printing. summarizes identical ballots */
function formatBallots(ballots) {
    const items = new Map();
    for (const ballot of ballots) {
        const s = formatBallot(ballot);
        if (items.has(s)) items.set(s, items.get(s) + 1);
        else items.set(s, 1);
    }
    return [...items.entries()].map(([k, v]) => `${k} × ${v}`).join('\n');
}

/** repeats a b times */
function repeat(a, b) {
    return [...new Array(b)].map(() => a);
}
/** convenience: creates an unordered array of 2 items */
function pair(a, b) {
    return unordered([a, b]);
}

/** encodes ballots into a buffer */
function encodeBallots(ballots) {
    const encoder = new BallotEncoder(ballots.length);
    for (const ballot of ballots) encoder.addBallot(ballot);
    return encoder.finish();
}

function testBallotEncoder() {
    const a = encodeBallots([
        [[1], [2], [3]],
        [[1, 2, 3]],
    ]);

    // assuming little endian
    assertEq(a, new Uint8Array([
        2, 0, 0, 0, // ballot count
        16, 0, 0, 0, // first ballot index
        26, 0, 0, 0, // second ballot index
        32, 0, 0, 0, // mentions index
        1, 0, 0, 0, 2, 0, 0, 0, 3, 0, // first ballot
        1, 0, 2, 0, 3, 0, // second ballot
        1, 0, 0, 0, // candidate 1
        2, 0, 0, 0, // has 2 mentions
        2, 0, 0, 0, // candidate 2
        2, 0, 0, 0, // has 2 mentions
        3, 0, 0, 0, // candidate 3
        2, 0, 0, 0, // has 2 mentions
    ]).buffer, 'incorrect ballot encoding');
}

function testRankedPairs() {
    // test boilerplate
    const expect = (name, maxWinners, candidates, ballots, tieBreaker, result) => {
        const ballotData = encodeBallots(ballots);
        const rpResult = rankedPairs(maxWinners, candidates, ballotData, tieBreaker);

        const mentionedCandidates = new Set();
        for (const b of ballots) for (const r of b) {
            if (typeof r === 'number') mentionedCandidates.add(r);
            else for (const i of r) mentionedCandidates.add(i);
        }
        const ignoredCandidates = [];
        for (const i of mentionedCandidates) if (!candidates.includes(i)) ignoredCandidates.push(i);

        let refResult;
        let refRound = 0;
        try {
            const refBallots = ballots.map(ballot => ballot.map(row => {
                if (typeof row === 'number') return String.fromCodePoint(row + 0x40);
                return row.map(cand => String.fromCodePoint(cand + 0x40));
            }));

            refResult = [];
            for (let i = 0; i < maxWinners; i++) {
                const result = ReferenceRankedPairs(
                    [...mentionedCandidates].map(cand => String.fromCodePoint(cand + 0x40)),
                    refBallots,
                    ignoredCandidates.map(cand => String.fromCodePoint(cand + 0x40)),
                    tieBreaker,
                );
                refResult.push(result);
                ignoredCandidates.push(result.winner.codePointAt(0) - 0x40);
                refRound++;
            }
        } catch (err) {
            refResult = `in round ${refRound + 1}: ` + err.toString();
        }

        assertEq(
            rpResult,
            result,
            'unexpected ranked pairs result for ballots:',
            '\n' + formatBallots(ballots),
            '\n\nreference:',
            refResult,
            '\n',
        );

        if (rpResult.status === 'success') {
            console.log(`\x1b[32m✓ ${name}\x1b[m`);
            console.log(`  winners: ${rpResult.value.winners.join(', ')}`);
            if (typeof refResult === 'string') {
                console.log(`  reference: ${refResult}`);
            } else {
                const winners = refResult.map(item => item.winner.codePointAt(0) - 0x40);
                console.log(`  reference: ${winners.join(', ')}`);
            }
        } else {
            if (typeof refResult !== 'string') {
                const winners = refResult.map(item => item.winner.codePointAt(0) - 0x40);
                refResult = `(succeeded with winners ${winners.join(', ')})`;
            }
            console.log(`\x1b[32m✓ ${name}\x1b[m`);
            console.log(`  status: ${result.status}`);
            console.log(`  reference: ${refResult}`);
        }
    };

    expect('normal case', 1, [1, 2, 3], [
        ...repeat([1, 2, 3], 7),
        ...repeat([2, 1, 3], 5),
        ...repeat([3, 1, 2], 4),
        ...repeat([2, 3, 1], 2),
    ], null, {
        status: 'success',
        value: {
            winners: [1],
            rounds: [{
                winner: 1,
                orderedPairs: [pair(2, 3), pair(1, 3), pair(1, 2)],
                lockGraphEdges: unordered([
                    pair(1, 2),
                    pair(1, 3),
                    pair(2, 3),
                ]),
            }],
        },
    });

    // ignored candidates
    expect('ignored candidates', 1, [1, 2], [
        ...repeat([1, 2, 3], 2),
    ], null, {
        status: 'success',
        value: {
            winners: [1],
            rounds: [{
                winner: 1,
                orderedPairs: [pair(1, 2)],
                lockGraphEdges: [pair(1, 2)],
            }],
        },
    });

    expect('single ballot', 1, [1, 2, 3], [
        ...repeat([1, 2, 3], 2),
    ], null, {
        status: 'tie-breaker-needed',
        pairs: unordered([pair(1, 2), pair(1, 3), pair(2, 3)]),
    });

    expect('single ballot 2', 1, [1, 2, 3], [
        ...repeat([1, 2], 2),
    ], null, {
        status: 'success',
        value: {
            winners: [1],
            rounds: [{
                winner: 1,
                orderedPairs: [pair(1, 2)],
                lockGraphEdges: [pair(1, 2)],
            }],
        },
    });

    // invoke tied pairs tie breaker
    expect('tied pairs (no tie breaker)', 1, [1, 2, 3, 4], [
        ...repeat([1, 2], 2),
        ...repeat([3, 4], 2),
    ], null, {
        status: 'tie-breaker-needed',
        pairs: [pair(3, 1)],
    });

    expect('tied pairs (tie breaker)', 1, [1, 2, 3, 4], [
        ...repeat([1, 2], 2),
        ...repeat([3, 4], 2),
    ], [1, 3, 2, 4], {
        status: 'success',
        value: {
            winners: [1],
            rounds: [{
                winner: 1,
                orderedPairs: [pair(1, 2), pair(3, 4), ...whateverRest()],
                lockGraphEdges: unordered([pair(1, 2), pair(3, 4), pair(1, 3), ...whateverRest()]),
            }],
        }
    });

    expect('multiple winners', 2, [1, 2, 3, 4], [
        ...repeat([1, 2, 3, 4], 4),
        ...repeat([[2, 3], 4, 1], 2),
        [[1], [3], [2, 4]],
    ], null, {
        status: 'success',
        value: {
            winners: [1, 2],
            ...whateverKeys(),
        },
    });

    expect('majority empty', 1, [1, 2, 3], [
        [], [], [], [1, 2, 3], [1, 2, 3],
    ], null, {
        status: 'majority-empty',
    });
}

function testSingleTransferableVote() {
    // test boilerplate
    const expect = (name, maxWinners, candidates, ballots, tieBreaker, result) => {
        const ballotData = encodeBallots(ballots);
        const stvResult = singleTransferableVote(maxWinners, candidates, ballotData, tieBreaker);

        let refResult;
        try {
            const refCandidates = candidates.map(cand => String.fromCodePoint(cand + 0x40));
            const refBallots = ballots.map(ballot => ballot.map(cand => String.fromCodePoint(cand + 0x40)).join(''));
            const refTieBreaker = tieBreaker && tieBreaker.map(cand => String.fromCodePoint(cand + 0x40)).join('');
            refResult = ReferenceSingleTransferableVote(maxWinners, refCandidates, refBallots, [], refTieBreaker);
        } catch (err) {
            refResult = err.toString();
        }

        assertEq(
            stvResult,
            result,
            'unexpected single transferable vote result for ballots:',
            '\n' + formatBallots(ballots),
            '\n\nreference:',
            refResult,
            '\n\nevent log (if available):',
            stvResult.value?.events,
        );

        if (stvResult.status === 'success') {
            console.log(`\x1b[32m✓ ${name}\x1b[m`);
            console.log(`  winners: ${stvResult.value.winners.join(', ')}`);
            if (typeof refResult === 'string') {
                console.log(`  reference: ${refResult}`);
            } else {
                const winners = refResult.winners.map(item => item.codePointAt(0) - 0x40);
                console.log(`  reference: ${winners.join(', ')}`);
            }
        } else {
            if (typeof refResult !== 'string') {
                const winners = refResult.winners.map(item => item.codePointAt(0) - 0x40);
                refResult = `(succeeded with winners ${winners.join(', ')})`;
            }
            console.log(`\x1b[32m✓ ${name}\x1b[m`);
            console.log(`  status: ${stvResult.status}`);
            console.log(`  reference: ${refResult}`);
        }
    };

    expect('basic case', 3, [1, 2, 3, 4, 5, 6, 7, 8], [
        ...repeat([1, 2, 3, 4], 4),
        [2, 1, 3, 4],
    ], null, {
        status: 'success',
        value: {
            winners: [1, 2, 3],
            events: WHATEVER,
        },
    });

    expect('single ballot', 3, [1, 2, 3, 4, 5, 6, 7, 8], [
        [1, 2, 3],
    ], null, {
        status: 'success',
        value: {
            winners: [1, 2, 3],
            events: WHATEVER,
        },
    });

    expect('two opposing ballots', 3, [1, 2, 3, 4, 5, 6, 7, 8], [
        [1, 2, 3],
        [4, 5, 6],
    ], null, {
        status: 'tie-breaker-needed',
        tiedNodes: WHATEVER,
    });

    expect('elimination tie', 2, [1, 2, 3], [
        [1, 2, 3],
        [1, 3, 2],
        ], null, {
        status: 'tie-breaker-needed',
        tiedNodes: unordered([2, 3]),
    });

    expect('too few candidates', 6, [1, 2, 3], [
        [1, 2, 3],
    ], null, {
        status: 'success',
        value: {
            winners: unordered([1, 2, 3]),
            events: [
                { type: 'elect-rest', ...whateverKeys() },
            ],
        },
    });

    expect('real data', 8, [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13], [
        [3, 9], [0, 8, 9, 2, 1, 6, 5, 12], [11, 8, 9, 7, 6, 3], [3, 8, 5, 11], [0, 5, 6, 2, 8, 9, 10, 12],
        [5, 0, 8, 2, 11, 4, 9, 6], [12, 10, 5, 4, 6, 2, 11, 0], [7, 6, 12, 10, 0, 5, 2, 8, 11, 9, 1],
        [10, 5, 6, 12, 4, 7, 2, 0, 11, 8, 3, 9, 1], [6, 12, 10, 0, 7, 5, 2], [8, 9, 11, 7, 6, 3, 10, 2],
        [6, 5, 9, 8, 4, 10, 12, 2, 3, 7, 11, 0, 1], [9, 4, 2, 0, 8, 5, 10, 12, 6, 7, 3, 11, 1],
        [6, 5, 0, 9, 1, 2, 8, 7, 11, 3, 4, 10, 12], [0, 8, 5, 3, 10, 12, 7, 6, 9, 11, 4, 2, 1],
        [8, 9, 12, 10, 0, 5, 3, 6, 7, 2, 1, 4, 11], [5, 10, 12, 3, 2, 6, 1, 11, 0, 4, 9, 8, 7],
        [5, 6, 0, 1, 11, 3, 2, 8, 4, 9, 12, 10, 7], [10, 9, 5, 6, 7, 8, 4, 2, 3, 12], [11, 3, 7, 5, 10, 2, 12, 6],
        [6, 7, 0, 5, 4, 3, 12, 10, 9, 11, 1, 8, 2], [10, 12, 9, 0, 11, 8, 4, 6], [11, 8, 9, 6, 3, 10, 12, 7],
        [9, 8, 11, 4, 0], [12, 6, 5, 10, 7, 1, 3, 0], [12, 6, 5, 10, 7, 1, 3, 0], [5, 6, 9, 8, 4, 10, 11, 3, 7, 0],
        [4, 3, 10, 12, 2, 7, 5, 9],
        // these ballots are zero-indexed
    ].map(ballot => ballot.map(i => i + 1)), [5, 12, 0, 10, 7, 6, 1, 3, 9, 8, 2, 11, 4], {
        status: 'success',
        value: {
            winners: unordered([6, 7, 1, 11, 13, 4, 9, 12]),
            events: WHATEVER,
        },
    });
}

testBallotEncoder();

console.log('- ranked pairs -');
testRankedPairs();

console.log('\n- single transferable vote -');
testSingleTransferableVote();

console.log('\n\x1b[32m✓ seems fine\x1b[m');