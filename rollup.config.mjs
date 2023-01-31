import typescript from '@rollup/plugin-typescript';

const inputOptions = () => ({
    input: 'src/index.ts',
    plugins: [
        typescript(),
    ],
});

export default [
    {
        output: {
            file: 'dist/index.mjs',
            format: 'esm',
        },
        ...inputOptions(),
    },
    {
        output: {
            file: 'dist/index.cjs',
            format: 'cjs',
        },
        ...inputOptions(),
    }
];
