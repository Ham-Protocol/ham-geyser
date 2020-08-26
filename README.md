# Token Geyser

A smart-contract based mechanism to distribute tokens over time, made by Ampleforth, inspired loosely by Compound and Uniswap.

Implementation of [Continuous Vesting Token Distribution](https://github.com/ampleforth/RFCs/blob/master/RFCs/rfc-1.md)

The official Geyser contract addresses are (by target):
- UniswapV2 [ETH/HAM](https://uniswap.exchange/swap?outputCurrency=TODO) Pool: [address](https://etherscan.io/)

## Table of Contents

- [Install](#install)
- [Testing](#testing)
- [Contribute](#contribute)
- [License](#license)


## Install

```bash
# Install project dependencies
npm install

# Install ethereum local blockchain(s) and associated dependencies
npx setup-local-chains
```

## Testing

``` bash
# You can use the following command to start a local blockchain instance
npx start-chain [ganacheUnitTest|gethUnitTest]

# Run all unit tests
npm test

# Run unit tests in isolation
npx mocha test/staking.js --exit
```

## Contribute

To report bugs within this package, please create an issue in this repository.
When submitting code ensure that it is free of lint errors and has 100% test coverage.

``` bash
# Lint code
npm run lint

# View code coverage
npm run coverage
```

## License

[GNU General Public License v3.0 (c) 2020 Fragments, Inc.](./LICENSE)
