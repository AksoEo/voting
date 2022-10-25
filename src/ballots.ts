/**
 * Encodes ranking ballots into an array buffer.
 *
 * # Format
 * - `count: uint32` - number of ballots
 * - `pointers: uint32[count]` - offset of each ballot from beginning of buffer
 * - `end_pointer: uint32` - pointer to location immediately after last ballot
 * - `ballots: Ballot[count]`
 * - `candidate_mentions: CandidateMention[candidates]`
 *
 * Each `Ballot` is a variable-length array of `uint16` values.
 * Nonzero values indicate a particular candidate, and zero indicates a row separator.
 *
 * For example, the following ballot:
 *
 * 1. candidates 1, 2
 * 2. candidate 3
 *
 * will be encoded as `[1, 2, 0, 3]` (uint16 values).
 *
 * Each `CandidateMention` is a tuple of `candidate_id: uint32` and `candidate_mentions: uint32`.
 *
 * Endianness is unspecified because I cannot find any information about endianness of Javascript TypedArrays;
 * i.e. avoid storing or transmitting the resulting array.
 */
export class BallotEncoder {
    ballots: ArrayBuffer;
    ballots32: Uint32Array;
    ballots16: Uint16Array;

    ballotIndex = 1;
    ballotCursor: number;

    candidateMentions = new Map<number, number>();

    /**
     * Creates a new encoder.
     *
     * - count: number of ballots that will be encoded (exact)
     */
    constructor(count: number) {
        // reserve ballot count, ballot pointers, and one entry for each ballot
        this.ballots = new ArrayBuffer(2 ** Math.ceil(Math.log2(6 * count + 4)));
        this.ballotCursor = 8 + 4 * count;
        this.ballots32 = new Uint32Array(this.ballots);
        this.ballots16 = new Uint16Array(this.ballots);
        this.ballots32[0] = count;
    }

    #resize(size: number) {
        this.ballots = new ArrayBuffer(size);
        const ballots32 = new Uint32Array(this.ballots);
        ballots32.set(this.ballots32);
        this.ballots32 = ballots32;
        this.ballots16 = new Uint16Array(this.ballots);
    }

    /**
     * Resizes if necessary such that the index can be written to. Uses exponential allocation.
     */
    #resizeToWriteAt(index: number) {
        if (this.ballots.byteLength <= index) {
            const nextSize = 2 ** (Math.ceil(Math.log2(this.ballots.byteLength)) + 1);
            this.#resize(nextSize);
        }
    }

    /**
     * Adds another ballot.
     *
     * Will crash if the number of ballots added exceeds the count passed to the constructor.
     */
    addBallot(ranks: (number[] | number)[]) {
        // set pointer
        this.ballots32[this.ballotIndex++] = this.ballotCursor;

        // write ranks
        let cursor16 = this.ballotCursor / Uint16Array.BYTES_PER_ELEMENT;
        let isFirstRank = true;
        for (const rank of ranks) {
            if (isFirstRank) {
                isFirstRank = false;
            } else {
                // rank separator
                this.#resizeToWriteAt(cursor16 * Uint16Array.BYTES_PER_ELEMENT);
                this.ballots16[cursor16++] = 0;
            }

            if (typeof rank === 'number') {
                this.#resizeToWriteAt(cursor16 * Uint16Array.BYTES_PER_ELEMENT);
                this.ballots16[cursor16++] = rank;

                const currentMentions = this.candidateMentions.get(rank) || 0;
                this.candidateMentions.set(rank, currentMentions + 1);
            } else {
                for (const item of rank) {
                    if (!item) throw new Error('ballot item cannot be 0');
                    this.#resizeToWriteAt(cursor16 * Uint16Array.BYTES_PER_ELEMENT);
                    this.ballots16[cursor16++] = item;

                    const currentMentions = this.candidateMentions.get(item) || 0;
                    this.candidateMentions.set(item, currentMentions + 1);
                }
            }
        }

        this.ballotCursor = cursor16 * Uint16Array.BYTES_PER_ELEMENT;
    }

    #writeMentions() {
        this.ballots32[this.ballotIndex++] = this.ballotCursor;
        let cursor32 = Math.ceil(this.ballotCursor / Uint32Array.BYTES_PER_ELEMENT);

        for (const [candidate, mentions] of this.candidateMentions) {
            this.#resizeToWriteAt(cursor32 * Uint32Array.BYTES_PER_ELEMENT);
            this.ballots32[cursor32++] = candidate;
            this.#resizeToWriteAt(cursor32 * Uint32Array.BYTES_PER_ELEMENT);
            this.ballots32[cursor32++] = mentions;
        }

        this.ballotCursor = cursor32 * Uint32Array.BYTES_PER_ELEMENT;
    }

    /**
     * Shrinks the buffer to fit and returns it.
     */
    finish(): ArrayBuffer {
        this.#writeMentions();

        const newLen = Math.ceil(this.ballotCursor / Uint32Array.BYTES_PER_ELEMENT) * Uint32Array.BYTES_PER_ELEMENT;
        const ballots = new ArrayBuffer(newLen);
        const slice = this.ballots16.slice(0, newLen / 2);
        new Uint16Array(ballots).set(slice);
        return ballots;
    }
}