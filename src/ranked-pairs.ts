import { Node } from './config';
type EdgeKey = string;

export enum RpStatus {
    Success = 'success',
    TieBreakerNeeded = 'tie-breaker-needed',
    IncompleteTieBreaker = 'incomplete-tie-breaker',
    MajorityEmpty = 'majority-empty',
}

export type RpResult<T, N> = {
    status: RpStatus.Success;
    value: T;
} | {
    status: RpStatus.TieBreakerNeeded;
    pairs: [N, N][];
} | {
    status: RpStatus.IncompleteTieBreaker;
    missing: N[];
} | {
    status: RpStatus.MajorityEmpty;
};

/** ranked pairs output */
export interface RpData<N> {
    winners: N[];
    rounds: RpRound<N>[];
}

/** ranked pairs round output */
export interface RpRound<N> {
    /** the node that won this round */
    winner: N,
    /** order of pairs this round */
    orderedPairs: [N, N][];
    /** edges of the lock graph this round */
    lockGraphEdges: [N, N][];
}

// for converting from one candidate type to another
export function remapRpRound<N, M>(round: RpRound<N>, remap: (node: N) => M): RpRound<M> {
    return {
        winner: remap(round.winner),
        orderedPairs: round.orderedPairs.map(([a, b]) => [remap(a), remap(b)]),
        lockGraphEdges: round.lockGraphEdges.map(([a, b]) => [remap(a), remap(b)]),
    };
}
export function remapRpData<N, M>(data: RpData<N>, remap: (node: N) => M): RpData<M> {
    return {
        winners: data.winners.map(remap),
        rounds: data.rounds.map(round => remapRpRound(round, remap)),
    };
}
export function remapRpResult<N, M>(data: RpResult<RpData<N>, N>, remap: (node: N) => M): RpResult<RpData<M>, M> {
    if (data.status === RpStatus.Success) {
        return { status: data.status, value: remapRpData(data.value, remap) };
    } else if (data.status === RpStatus.TieBreakerNeeded) {
        return { status: data.status, pairs: data.pairs.map(([a, b]) => [remap(a), remap(b)]) };
    } else if (data.status === RpStatus.IncompleteTieBreaker) {
        return { status: data.status, missing: data.missing.map(remap) };
    }
}

enum GraphDir {
    Outgoing,
    Incoming,
}

/** keys for the graph edge map. javascript does not have value types, so to get a == b behavior we need to stringify */
function edgeKey(a: Node, b: Node): EdgeKey {
    return a + '!' + b;
}

/** a simple graph */
class DiGraph<E> {
    /**
     * stores graph nodes.
     * an edge like a->b creates a: [[b, Outgoing]] and b: [[a: Incoming]].
     */
    nodes: Map<Node, [Node, GraphDir][]> = new Map();
    /** stores graph edge data */
    edges: Map<EdgeKey, E> = new Map();

    /** inserts a node */
    insertNode(n: Node) {
        if (!this.nodes.has(n)) this.nodes.set(n, []);
    }

    /** removes a node */
    removeNode(n: Node) {
        const links = this.nodes.get(n);
        if (!links) return;
        this.nodes.delete(n);

        for (const [other, dir] of links) {
            if (dir === GraphDir.Incoming) {
                this.edges.delete(edgeKey(other, n));
            } else {
                this.edges.delete(edgeKey(n, other));
            }

            const conns = this.nodes.get(other);
            const index = conns.findIndex(([node, _]) => node === n);
            conns.splice(index, 1);
        }
    }

    /** returns edge data */
    edge(a: Node, b: Node): E {
        return this.edges.get(edgeKey(a, b));
    }

    /** returns all nodes with edges between them */
    getAllEdges(): [Node, Node][] {
        const edges = [];
        for (const [node, neighbors] of this.nodes) {
            for (const [other, dir] of neighbors) {
                if (dir === GraphDir.Outgoing) {
                    edges.push([node, other]);
                }
            }
        }
        return edges;
    }

    /** inserts an edge between two nodes. overrides any existing edge */
    insertEdge(a: Node, b: Node, data: E) {
        if (!this.nodes.has(a)) throw new Error(`node ${a} not found here`);
        if (!this.nodes.has(b)) throw new Error(`node ${b} not found here`);
        const key = edgeKey(a, b);
        if (this.edges.has(key)) return;
        this.edges.set(key, data);
        this.nodes.get(a).push([b, GraphDir.Outgoing]);
        this.nodes.get(b).push([a, GraphDir.Incoming]);
    }

    /** removes an edge from the graph */
    removeEdge(a: Node, b: Node) {
        const key = edgeKey(a, b);
        if (!this.edges.has(key)) return;
        this.edges.delete(edgeKey(a, b));

        const aConns = this.nodes.get(a);
        const bConns = this.nodes.get(b);
        const aIndex = aConns.findIndex(([node, _]) => node === b);
        const bIndex = bConns.findIndex(([node, _]) => node === a);
        aConns.splice(aIndex, 1);
        bConns.splice(bIndex, 1);
    }

    /** returns all outgoing neighbors of a node */
    outgoingNeighbors(n: Node): Node[] {
        return this.nodes.get(n)
            .filter(([_, dir]) => dir === GraphDir.Outgoing)
            .map(([node, _]) => node);
    }

    /**
     * returns true if the target node is reachable from the source node in an acyclic graph,
     * i.e. connecting the target to the source *would* create a cycle.
     * will throw a stack overflow if the graph is already cyclic.
     */
    isReachableInAcyclic(source: Node, target: Node): boolean {
        for (const node of this.outgoingNeighbors(source)) {
            if (node === target) return true;
            if (this.isReachableInAcyclic(node, target)) return true;
        }
        return false;
    }

    /** returns all nodes with no incoming edges */
    findRoots(): Node[] {
        return [...this.nodes.entries()]
            .filter(([, neighbors]) => {
                for (const [, dir] of neighbors) {
                    if (dir === GraphDir.Incoming) return false;
                }
                return true;
            })
            .map(([node, _]) => node);
    }
}

type Ballots16 = Uint16Array;
type BallotIndex = number;

/**
 * compare nodes according to the ordering specified by the ballot. see BallotEncoder for format details.
 * negative if rank a < rank b, zero if rank a == rank b, positive if rank a > rank b.
 * the magnitude will be the difference in rank.
 * it will be infinite if one of the nodes is not present on the ballot.
 */
function compareNodesAccordingToBallot(ballots: Ballots16, ballotStart: BallotIndex, ballotEnd: BallotIndex, a: Node, b: Node) {
    let rankA = null;
    let rankB = null;
    let rank = 0;

    let i = ballotStart / Uint16Array.BYTES_PER_ELEMENT;
    const maxI = ballotEnd / Uint16Array.BYTES_PER_ELEMENT;

    while (i < maxI) {
        const value = ballots[i];
        if (value === 0) {
            rank++;
        } else if (value === a) {
            rankA = rank;
        } else if (value === b) {
            rankB = rank;
        }
        if (rankA !== null && rankB !== null) break;
        i++;
    }

    if (rankA === null && rankB === null) return 0;
    if (rankA === null) return -Infinity;
    if (rankB === null) return Infinity;
    return rankB - rankA;
}

/** filters for valid candidates (point 6) */
function filterCandidates(candidates: Node[], ballots: ArrayBuffer): Node[] {
    const ballots32 = new Uint32Array(ballots);

    const ballotCount = ballots32[0];
    const mentionsIndex = ballots32[1 + ballotCount];

    const mentions = new Map<Node, number>();
    let i = mentionsIndex / Uint32Array.BYTES_PER_ELEMENT;
    while (i < ballots32.length) {
        const candidate = ballots32[i++];
        const count = ballots32[i++];
        mentions.set(candidate, count);
    }

    // point 6: candidates have to appear in at least half the ballots to count
    const threshold = ballotCount / 2;
    return candidates.filter(candidate => mentions.get(candidate) >= threshold);
}

/** Data stored on an edge of the ranked pairs graph */
interface RpEdgeData {
    /** number of ballots that contributed to this difference */
    ballots: number;
    /** the difference leftVotes - rightVotes (positive if left has more votes, negative if right has more votes) */
    diff: number;
    /** will be set later: true if left won */
    leftWon: boolean;
    /** will be set later: true if right won */
    rightWon: boolean;
}

/** builds the ranked pairs graph (point 7). candidates must be sorted */
function buildGraph(candidates: Node[]): DiGraph<RpEdgeData> {
    const graph = new DiGraph<RpEdgeData>();

    for (const cand of candidates) {
        graph.insertNode(cand);
    }

    for (const cand of candidates) {
        for (const otherCand of candidates) {
            if (otherCand >= cand) break;
            graph.insertEdge(cand, otherCand, {
                ballots: 0,
                diff: 0,
                leftWon: false,
                rightWon: false,
            });
        }
    }

    return graph;
}

/** applies ballots to the graph (point 8). candidates must be sorted */
function applyBallots(graph: DiGraph<RpEdgeData>, candidates: Node[], ballots: ArrayBuffer): RpResult<void, Node> {
    const ballots32 = new Uint32Array(ballots);
    const ballots16 = new Uint16Array(ballots);
    const ballotCount = ballots32[0];
    let emptyBallots = 0;

    for (let i = 0; i < ballotCount; i++) {
        const ballotStart = ballots32[i + 1];
        let ballotEnd = ballots32[i + 2];
        let isEmpty = true;

        for (const cand of candidates) {
            for (const otherCand of candidates) {
                if (otherCand >= cand) break;
                const diff = compareNodesAccordingToBallot(ballots16, ballotStart, ballotEnd, cand, otherCand);
                if (diff) {
                    const unitDiff = Math.sign(diff);

                    const edgeData = graph.edge(cand, otherCand);
                    edgeData.diff += unitDiff;
                    edgeData.ballots++;
                    isEmpty = false;
                }
            }
        }

        if (isEmpty) emptyBallots++;
    }

    if (emptyBallots >= ballotCount / 2) {
        return { status: RpStatus.MajorityEmpty };
    }

    return { status: RpStatus.Success, value: null };
}

/** finds the winner on each RP graph edge (point 8) */
function applyWinners(graph: DiGraph<RpEdgeData>, candidates: Node[], tieBreaker: number[] | null): RpResult<void, Node> {
    for (const cand of candidates) {
        for (const otherCand of candidates) {
            if (otherCand >= cand) break;
            const data = graph.edge(cand, otherCand);
            if (!data.ballots) {
                continue;
            }
            if (data.diff > 0) {
                // cand won
                data.leftWon = true;
            } else if (data.diff < 0) {
                // other cand won
                data.rightWon = true;
            } else {
                // a tie! consult the tie-breaker
                if (!tieBreaker) {
                    // tie breaker needed
                    return { status: RpStatus.TieBreakerNeeded, pairs: [[cand, otherCand]] };
                }

                let rankA = tieBreaker.indexOf(cand);
                let rankB = tieBreaker.indexOf(otherCand);

                if (rankA === -1 || rankB === -1) {
                    return { status: RpStatus.IncompleteTieBreaker, missing: [cand, otherCand] };
                }

                if (rankA < rankB) {
                    data.leftWon = true;
                } else {
                    data.rightWon = true;
                }
            }
        }
    }

    return { status: RpStatus.Success, value: null };
}

/** orders pairs for insertion into the lock graph (points 9, 10) */
function orderPairs(pairs: [Node, Node][], graph: DiGraph<RpEdgeData>, tieBreaker: Node[]): RpResult<[Node, Node][], Node> {
    // convenience function for obtaining the difference value of a pair
    const pairDiff = ([a, b]) => {
        return graph.edge(a, b).diff;
    };

    const orderedPairs: [Node, Node][] = [];
    // keep track of nodes that have won in an entry of orderedPairs
    const orderedPairWinningNodes = new Set<Node>();
    // keep track of nodes that have lost in an entry of orderedPairs
    const orderedPairLosingNodes = new Set<Node>();

    const queuedPairs = pairs.slice();
    // sort descending by magnitude of difference
    queuedPairs.sort((a, b) => Math.abs(pairDiff(b)) - Math.abs(pairDiff(a)));

    while (queuedPairs.length) {
        // the winning difference (largest difference magnitude) is the difference of the first pair
        const winningDiff = Math.abs(pairDiff(queuedPairs[0]));
        // count number of pairs that also have the winning difference
        let winningPairs = 1;
        for (let i = 1; i < queuedPairs.length; i++) {
            if (Math.abs(pairDiff(queuedPairs[i])) === winningDiff) {
                winningPairs = i + 1;
            } else {
                break;
            }
        }

        if (winningPairs > 1) {
            // there are tied pairs!
            const tiedPairs = new Set<[Node, Node]>(queuedPairs.splice(0, winningPairs));

            // add entries that already lost, from most losses to least
            // (since we are iterating a sorted list, we don’t need to sort again)
            for (const pair of [...tiedPairs]) {
                const [a, b] = pair;
                const edgeData = graph.edge(a, b);
                const winningNode = edgeData.leftWon ? a : b;
                const losingNode = edgeData.leftWon ? b : a;

                if (orderedPairLosingNodes.has(losingNode)) {
                    orderedPairs.push(pair);
                    orderedPairWinningNodes.add(winningNode);
                    tiedPairs.delete(pair);
                }
            }

            // add entries that already won. ditto
            for (const pair of [...tiedPairs]) {
                const [a, b] = pair;
                const edgeData = graph.edge(a, b);
                const winningNode = edgeData.leftWon ? a : b;
                const losingNode = edgeData.leftWon ? b : a;

                if (orderedPairWinningNodes.has(winningNode)) {
                    orderedPairs.push(pair);
                    orderedPairLosingNodes.add(losingNode);
                    tiedPairs.delete(pair);
                }
            }

            if (tiedPairs.size > 1) {
                // in case of further equality, list the pair whose losing node is least preferred by the tie breaker first
                if (!tieBreaker) {
                    return { status: RpStatus.TieBreakerNeeded, pairs: [...tiedPairs] };
                }

                // collect all the items we encounter that are missing from the tie breaker
                const missingTieBreakerItems = new Set<Node>();

                const sortedTiedPairs = [...tiedPairs].sort(([a, b], [c, d]) => {
                    const leftData = graph.edge(a, b);
                    const rightData = graph.edge(c, d);
                    const losingLeft = leftData.leftWon ? b : a;
                    const losingRight = rightData.leftWon ? d : c;

                    const leftIndex = tieBreaker.indexOf(losingLeft);
                    const rightIndex = tieBreaker.indexOf(losingRight);

                    if (leftIndex === -1 || rightIndex === -1) {
                        missingTieBreakerItems.add(losingLeft);
                        missingTieBreakerItems.add(losingRight);
                        return 0;
                    }

                    // left index < right index => right node is less preferred => sort right first => negative result
                    return leftIndex - rightIndex;
                });

                if (missingTieBreakerItems.size) {
                    return { status: RpStatus.IncompleteTieBreaker, missing: [...missingTieBreakerItems] };
                }

                orderedPairs.push(...sortedTiedPairs);
            } else {
                // there’s only be one remaining (but indexing a Set is annoying, so we'll splat)
                orderedPairs.push(...tiedPairs);
            }
        } else {
            // no tie; trivial case
            const [a, b] = queuedPairs.shift();
            const edgeData = graph.edge(a, b);
            orderedPairs.push([a, b]);
            orderedPairWinningNodes.add(edgeData.leftWon ? a : b);
            orderedPairLosingNodes.add(edgeData.leftWon ? b : a);
        }
    }

    return { status: RpStatus.Success, value: orderedPairs };
}

/** creates the lock graph and finds the winner for the current round */
function lockGraphAndFindRoundWinner(
    mentionedCandidates: Set<Node>,
    graph: DiGraph<RpEdgeData>,
    orderedPairs: [Node, Node][],
    tieBreaker: Node[],
): RpResult<RpRound<Node>, Node> {
    // “lock in” pairs from strongest to weakest, avoiding cycles
    const lockGraph = new DiGraph<void>();

    for (const cand of mentionedCandidates) {
        lockGraph.insertNode(cand);
    }

    for (let [a, b] of orderedPairs) {
        const edgeData = graph.edge(a, b);
        if (edgeData.leftWon && !lockGraph.isReachableInAcyclic(b, a)) {
            lockGraph.insertEdge(a, b);
        } else if (edgeData.rightWon && !lockGraph.isReachableInAcyclic(a, b)) {
            lockGraph.insertEdge(b, a);
        }
    }

    // winners are the roots of the graph, i.e. any node with no incoming edges
    const roundWinners = lockGraph.findRoots();

    let roundWinner: Node;
    if (roundWinners.length === 1) {
        roundWinner = roundWinners[0];
    } else {
        // more than one winning node!
        // this can happen when we have two candidates that never appear on the same ballot,
        // creating a lock graph like 1->2, 3->4. In this case, we have two roots, 1 and 3.
        // in this case, we'll consult the tie breaker and add more lock graph edges between the winners.

        if (!tieBreaker) {
            const winnerPairs = [];
            for (const node of roundWinners) {
                for (const otherNode of roundWinners) {
                    if (otherNode < node) winnerPairs.push([node, otherNode]);
                }
            }
            return { status: RpStatus.TieBreakerNeeded, pairs: winnerPairs };
        }

        // sort ascending
        roundWinners.sort((a, b) => a - b);

        // collect all the items we encounter that are missing from the tie breaker
        const missingTieBreakerItems = new Set<Node>();

        for (const node of roundWinners) {
            for (const otherNode of roundWinners) {
                if (otherNode >= node) break;

                const leftIndex = tieBreaker.indexOf(node);
                const rightIndex = tieBreaker.indexOf(otherNode);

                if (leftIndex === -1) missingTieBreakerItems.add(leftIndex);
                if (rightIndex === -1) missingTieBreakerItems.add(rightIndex);

                if (leftIndex < rightIndex) {
                    // left node preferred
                    lockGraph.insertEdge(node, otherNode);
                } else {
                    lockGraph.insertEdge(otherNode, node);
                }
            }
        }

        if (missingTieBreakerItems.size) {
            return {
                status: RpStatus.IncompleteTieBreaker,
                missing: [...missingTieBreakerItems],
            };
        }

        // compute again. this time, there should be enough edges for it to be unambiguous...
        const newRoundWinners = lockGraph.findRoots();

        if (newRoundWinners.length > 1) throw new Error('something is very wrong (more than one winner for this round)');
        roundWinner = newRoundWinners[0];
    }

    return {
        status: RpStatus.Success,
        value: {
            winner: roundWinner,
            orderedPairs,
            lockGraphEdges: lockGraph.getAllEdges(),
        },
    };
}

/** performs ranked-pairs voting */
export function rankedPairs(maxWinners: number, candidates: Node[], ballots: ArrayBuffer, tieBreaker: Node[] | null): RpResult<RpData<Node>, Node> {
    const sortedCandidates = filterCandidates(candidates.sort((a, b) => a - b), ballots);
    maxWinners = Math.min(maxWinners, sortedCandidates.length);

    const graph = buildGraph(sortedCandidates);

    {
        const result = applyBallots(graph, sortedCandidates, ballots);
        if (result.status !== RpStatus.Success) {
            return result as RpResult<any, Node>;
        }
    }

    {
        const result = applyWinners(graph, sortedCandidates, tieBreaker);
        if (result.status !== RpStatus.Success) {
            return result as RpResult<any, Node>;
        }
    }

    // we need a list of mentioned candidates for the lock graph
    const mentionedCandidates = new Set<Node>();
    // create candidate pairs so we can order them and find a winner
    let pairs = [];
    for (const cand of sortedCandidates) {
        for (const otherCand of sortedCandidates) {
            if (otherCand >= cand) break;
            if (graph.edge(cand, otherCand).ballots) {
                mentionedCandidates.add(cand);
                mentionedCandidates.add(otherCand);
                pairs.push([cand, otherCand]);
            }
        }
    }

    const winners: Node[] = [];
    const rounds: RpRound<Node>[] = [];

    while (true) {
        const orderPairsResult = orderPairs(pairs, graph, tieBreaker);
        if (orderPairsResult.status !== RpStatus.Success) {
            return orderPairsResult as RpResult<any, Node>;
        }
        const orderedPairs = orderPairsResult.value;

        const roundResult = lockGraphAndFindRoundWinner(mentionedCandidates, graph, orderedPairs, tieBreaker);
        if (roundResult.status !== RpStatus.Success) {
            return roundResult as RpResult<any, Node>;
        }
        const roundWinner = roundResult.value.winner;

        rounds.push(roundResult.value);
        winners.push(roundWinner);

        if (winners.length >= maxWinners) {
            // we found all winners! exit
            break;
        }

        // point 13: remove this winner and find the next winner
        pairs = pairs.filter(([a, b]) => a !== roundWinner && b !== roundWinner);
        mentionedCandidates.delete(roundWinner);
    }

    return {
        status: RpStatus.Success,
        value: {
            winners,
            rounds,
        },
    };
}
