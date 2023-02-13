//! test utilities

const unorderedArrays = new WeakSet();

/** marks an array as unordered, allowing assertEq to match items out of order */
export function unordered(array) {
    unorderedArrays.add(array);
    return array;
}

/** symbol that will cause assertEq patterns to match anything on the left-hand side */
export const WHATEVER = Symbol('whatever');

/** can be spilled into objects like { thing: 1, ...whateverKeys() } to ignore extra keys */
export function whateverKeys() {
    return { [WHATEVER]: true };
}

const WHATEVER_REST = Symbol('whatever');
/** can be spilled into arrays like [1, 2, ...whateverRest()] to ignore the rest */
export function whateverRest() {
    return [WHATEVER_REST];
}

/** compares a == b, adding errors to failOut (if given) */
function deepEq(a, b, failOut) {
    if (b === WHATEVER) return true;

    if (Array.isArray(a) && Array.isArray(b)) {
        const whateverRest = b.at(-1) === WHATEVER_REST;
        if (!whateverRest && a.length !== b.length) {
            failOut?.push([a, b, 'array length']);
            return false;
        }
        if (unorderedArrays.has(a) || unorderedArrays.has(b)) {
            const values = new Set(a);
            for (const item of b) {
                if (item === WHATEVER_REST) continue;
                let found = false;
                for (const value of values) {
                    if (deepEq(value, item)) {
                        found = true;
                        values.delete(value);
                        break;
                    }
                }
                if (!found) {
                    failOut?.push([item, null, 'item not found']);
                    failOut?.push([a, b, 'set items']);
                    return false;
                }
            }
            return true;
        }
        for (let i = 0; i < a.length; i++) {
            if (b[i] === WHATEVER_REST) break;
            if (!deepEq(a[i], b[i], failOut)) {
                failOut?.push([a, b, `index ${i}`]);
                return false;
            }
        }
        return true;
    }
    if (a instanceof ArrayBuffer && b instanceof ArrayBuffer) {
        if (a.byteLength !== b.byteLength) {
            failOut?.push([a, b, 'buffer length']);
            return false;
        }
        const a8 = new Uint8Array(a);
        const b8 = new Uint8Array(b);
        for (let i = 0; i < a8.length; i++) {
            if (a8[i] !== b8[i]) {
                failOut?.push([a, b, `index ${i}`]);
                return false;
            }
        }
        return true;
    }
    if (a instanceof Map && b instanceof Map) {
        const aKeys = new Set(a.keys());
        const bKeys = new Set(a.keys());

        if (!b.get(WHATEVER)) {
            if (aKeys.length !== bKeys.length) {
                failOut?.push([a, b, 'number of keys']);
                return false;
            }
        }

        for (const key of aKeys) {
            if (!bKeys.has(key)) {
                if (b.get(WHATEVER)) continue;
                failOut?.push([a, b, `missing key ${key}`]);
                return false;
            }
            if (!deepEq(a.get(key), b.get(key), failOut)) {
                failOut?.push([a, b, `item “${key}”`]);
                return false;
            }
        }
        return true;
    }
    if (typeof a === 'object' && typeof b === 'object') {
        if (a.prototype !== b.prototype) {
            failOut?.push([a, b, 'prototype']);
            return false;
        }

        const aKeys = new Set(Object.keys(a));
        const bKeys = new Set(Object.keys(b));

        if (!b[WHATEVER]) {
            if (aKeys.length !== bKeys.length) {
                failOut?.push([a, b, 'number of keys']);
                return false;
            }
        }

        for (const key of aKeys) {
            if (!bKeys.has(key)) {
                if (b[WHATEVER]) continue;
                failOut?.push([a, b, `missing key ${key}`]);
                return false;
            }
            if (!deepEq(a[key], b[key], failOut)) {
                failOut?.push([a, b, `item “${key}”`]);
                return false;
            }
        }
        return true;
    }
    if (Number.isNaN(a) && Number.isNaN(b)) return true;
    if (a !== b) {
        failOut?.push([a, b, 'value']);
        return false;
    }
    return true;
}

/** asserts a (value) == b (pattern) */
export function assertEq(a, b, ...msg) {
    let out = [];
    if (!deepEq(a, b, out)) {
        console.error('Assertion failed (left == right):', ...msg);
        for (const [a, b, pos] of out) {
            console.error('in', a, '==', b, 'at', pos);
        }
        throw new Error('assertion failed');
    }
}

/** asserts that the closure must fail */
export function assertError(closure, msg) {
    let succeeded = false;
    try {
        closure();
        succeeded = true;
    } catch {
        // ok
    }
    if (succeeded) {
        console.error('Assertion failed (no error thrown): ' + msg);
        throw new Error('assertion failed');
    }
}
