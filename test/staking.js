const { contract, web3 } = require('@openzeppelin/test-environment');
const { expectRevert, expectEvent, BN, constants } = require('@openzeppelin/test-helpers');
const { expect } = require('chai');

const _require = require('app-root-path').require;
const BlockchainCaller = _require('/util/blockchain_caller');
const chain = new BlockchainCaller(web3);
const {
  $HAM,
  invokeRebase
} = _require('/test/helper');

const HamErc20 = contract.fromArtifact('UFragments');
const TokenGeyser = contract.fromArtifact('TokenGeyser');
const InitialSharesPerToken = 10 ** 6;

let ham, dist, owner, anotherAccount;
describe('staking', function () {
  beforeEach('setup contracts', async function () {
    const accounts = await chain.getUserAccounts();
    owner = web3.utils.toChecksumAddress(accounts[0]);
    anotherAccount = web3.utils.toChecksumAddress(accounts[8]);

    ham = await HamErc20.new();
    await ham.initialize(owner);
    await ham.setMonetaryPolicy(owner);

    const startBonus = 50;
    const bonusPeriod = 86400;
    dist = await TokenGeyser.new(ham.address, ham.address, 10, startBonus, bonusPeriod,
      InitialSharesPerToken);
  });

  describe('when start bonus too high', function () {
    it('should fail to construct', async function () {
      await expectRevert(TokenGeyser.new(ham.address, ham.address, 10, 101, 86400, InitialSharesPerToken),
        'TokenGeyser: start bonus too high');
    });
  });

  describe('when bonus period is 0', function () {
    it('should fail to construct', async function () {
      await expectRevert(TokenGeyser.new(ham.address, ham.address, 10, 50, 0, InitialSharesPerToken),
        'TokenGeyser: bonus period is zero');
    });
  });

  describe('getStakingToken', function () {
    it('should return the staking token', async function () {
      expect(await dist.getStakingToken.call()).to.equal(ham.address);
    });
  });

  describe('token', function () {
    it('should return the staking token', async function () {
      expect(await dist.token.call()).to.equal(ham.address);
    });
  });

  describe('supportsHistory', function () {
    it('should return supportsHistory', async function () {
      expect(await dist.supportsHistory.call()).to.be.false;
    });
  });

  describe('stake', function () {
    describe('when the amount is 0', function () {
      it('should fail', async function () {
        await ham.approve(dist.address, $HAM(1000));
        await expectRevert.unspecified(dist.stake($HAM(0), []));
      });
    });

    describe('when token transfer has not been approved', function () {
      it('should fail', async function () {
        await ham.approve(dist.address, $HAM(10));
        await expectRevert.unspecified(dist.stake($HAM(100), []));
      });
    });

    describe('when totalStaked=0', function () {
      beforeEach(async function () {
        expect(await dist.totalStaked.call()).to.be.bignumber.equal($HAM(0));
        await ham.approve(dist.address, $HAM(100));
      });
      it('should updated the total staked', async function () {
        await dist.stake($HAM(100), []);
        expect(await dist.totalStaked.call()).to.be.bignumber.equal($HAM(100));
        expect(await dist.totalStakedFor.call(owner)).to.be.bignumber.equal($HAM(100));
        expect(await dist.totalStakingShares.call()).to.be.bignumber.equal($HAM(100).mul(new BN(InitialSharesPerToken)));
      });
      it('should log Staked', async function () {
        const r = await dist.stake($HAM(100), []);
        expectEvent(r, 'Staked', {
          user: owner,
          amount: $HAM(100),
          total: $HAM(100)
        });
      });
    });

    describe('when totalStaked>0', function () {
      beforeEach(async function () {
        expect(await dist.totalStaked.call()).to.be.bignumber.equal($HAM(0));
        await ham.transfer(anotherAccount, $HAM(50));
        await ham.approve(dist.address, $HAM(50), { from: anotherAccount });
        await dist.stake($HAM(50), [], { from: anotherAccount });
        await ham.approve(dist.address, $HAM(150));
        await dist.stake($HAM(150), []);
      });
      it('should updated the total staked', async function () {
        expect(await dist.totalStaked.call()).to.be.bignumber.equal($HAM(200));
        expect(await dist.totalStakedFor.call(anotherAccount)).to.be.bignumber.equal($HAM(50));
        expect(await dist.totalStakedFor.call(owner)).to.be.bignumber.equal($HAM(150));
        expect(await dist.totalStakingShares.call()).to.be.bignumber.equal($HAM(200).mul(new BN(InitialSharesPerToken)));
      });
    });

    describe('when totalStaked>0, rebase increases supply', function () {
      beforeEach(async function () {
        expect(await dist.totalStaked.call()).to.be.bignumber.equal($HAM(0));
        await ham.transfer(anotherAccount, $HAM(50));
        await ham.approve(dist.address, $HAM(50), { from: anotherAccount });
        await dist.stake($HAM(50), [], { from: anotherAccount });
        await ham.approve(dist.address, $HAM(150));
        await invokeRebase(ham, 100);
        expect(await dist.totalStaked.call()).to.be.bignumber.equal($HAM(100));
        await dist.stake($HAM(150), []);
      });
      it('should updated the total staked shares', async function () {
        expect(await dist.totalStaked.call()).to.be.bignumber.equal($HAM(250));
        expect(await dist.totalStakedFor.call(anotherAccount)).to.be.bignumber.equal($HAM(100));
        expect(await dist.totalStakedFor.call(owner)).to.be.bignumber.equal($HAM(150));
        expect(await dist.totalStakingShares.call()).to.be.bignumber.equal($HAM(125).mul(new BN(InitialSharesPerToken)));
      });
    });

    describe('when totalStaked>0, when rebase increases supply', function () {
      beforeEach(async function () {
        await ham.approve(dist.address, $HAM(51));
        await dist.stake($HAM(50), []);
      });
      it('should fail if there are too few mintedStakingShares', async function () {
        await invokeRebase(ham, 100 * InitialSharesPerToken);
        await expectRevert(
          dist.stake(1, []),
          'TokenGeyser: Stake amount is too small'
        );
      });
    });

    describe('when totalStaked>0, rebase decreases supply', function () {
      beforeEach(async function () {
        expect(await dist.totalStaked.call()).to.be.bignumber.equal($HAM(0));
        await ham.transfer(anotherAccount, $HAM(50));
        await ham.approve(dist.address, $HAM(50), {
          from: anotherAccount
        });
        await dist.stake($HAM(50), [], {
          from: anotherAccount
        });
        await ham.approve(dist.address, $HAM(150));
        await invokeRebase(ham, -50);
        expect(await dist.totalStaked.call()).to.be.bignumber.equal($HAM(25));
        await dist.stake($HAM(150), []);
      });
      it('should updated the total staked shares', async function () {
        expect(await dist.totalStaked.call()).to.be.bignumber.equal($HAM(175));
        expect(await dist.totalStakedFor.call(anotherAccount)).to.be.bignumber.equal($HAM(25));
        expect(await dist.totalStakedFor.call(owner)).to.be.bignumber.equal($HAM(150));
        expect(await dist.totalStakingShares.call()).to.be.bignumber.equal($HAM(350).mul(new BN(InitialSharesPerToken)));
      });
    });
  });

  describe('stakeFor', function () {
    describe('when the beneficiary is ZERO_ADDRESS', function () {
      it('should fail', async function () {
        await expectRevert(dist.stakeFor(constants.ZERO_ADDRESS, $HAM(100), []),
          'TokenGeyser: beneficiary is zero address');
      });
    });

    describe('when the beneficiary is a valid address', function () {
      beforeEach(async function () {
        expect(await dist.totalStaked.call()).to.be.bignumber.equal($HAM(0));
        await ham.approve(dist.address, $HAM(100));
      });
      it('should deduct hams for the staker', async function () {
        const b = await ham.balanceOf.call(owner);
        await dist.stakeFor(anotherAccount, $HAM(100), []);
        const b_ = await ham.balanceOf.call(owner);
        expect(b.sub(b_)).to.be.bignumber.equal($HAM(100));
      });
      it('should updated the total staked on behalf of the beneficiary', async function () {
        await dist.stakeFor(anotherAccount, $HAM(100), []);
        expect(await dist.totalStaked.call()).to.be.bignumber.equal($HAM(100));
        expect(await dist.totalStakedFor.call(anotherAccount)).to.be.bignumber.equal($HAM(100));
        expect(await dist.totalStakedFor.call(owner)).to.be.bignumber.equal($HAM(0));
        expect(await dist.totalStakingShares.call()).to.be.bignumber.equal($HAM(100).mul(new BN(InitialSharesPerToken)));
      });
      it('should log Staked', async function () {
        const r = await dist.stakeFor(anotherAccount, $HAM(100), []);
        expectEvent(r, 'Staked', {
          user: anotherAccount,
          amount: $HAM(100),
          total: $HAM(100)
        });
      });
    });
  });
});
