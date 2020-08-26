const { contract, web3 } = require('@openzeppelin/test-environment');
const { expectRevert, expectEvent, BN, time } = require('@openzeppelin/test-helpers');
const { expect } = require('chai');

const _require = require('app-root-path').require;
const BlockchainCaller = _require('/util/blockchain_caller');
const chain = new BlockchainCaller(web3);
const {
  $HAM,
  invokeRebase,
  checkHamAprox,
  TimeController
} = _require('/test/helper');

const HamErc20 = contract.fromArtifact('UFragments');
const TokenGeyser = contract.fromArtifact('TokenGeyser');
const InitialSharesPerToken = 10 ** 6;

const ONE_YEAR = 1 * 365 * 24 * 3600;

let ham, dist, owner, anotherAccount;
async function setupContractAndAccounts () {
  const accounts = await chain.getUserAccounts();
  owner = web3.utils.toChecksumAddress(accounts[0]);
  anotherAccount = web3.utils.toChecksumAddress(accounts[8]);

  ham = await HamErc20.new();
  await ham.initialize(owner);
  await ham.setMonetaryPolicy(owner);

  const startBonus = 50; // 50%
  const bonusPeriod = 86400; // 1 Day
  dist = await TokenGeyser.new(ham.address, ham.address, 10, startBonus, bonusPeriod,
    InitialSharesPerToken);

  await ham.transfer(anotherAccount, $HAM(50000));
  await ham.approve(dist.address, $HAM(50000), { from: anotherAccount });
  await ham.approve(dist.address, $HAM(50000), { from: owner });
}

async function totalRewardsFor (account) {
  return (await dist.updateAccounting.call({ from: account }))[4];
}

describe('unstaking', function () {
  beforeEach('setup contracts', async function () {
    await setupContractAndAccounts();
  });

  describe('unstake', function () {
    describe('when amount is 0', function () {
      it('should fail', async function () {
        await dist.stake($HAM(50), [], { from: anotherAccount });
        await expectRevert(
          dist.unstake($HAM(0), [], { from: anotherAccount }),
          'TokenGeyser: unstake amount is zero'
        );
      });
    });

    describe('when rebase increases supply', function () {
      beforeEach(async function () {
        await dist.stake($HAM(50), [], { from: anotherAccount });
        await time.increase(1);
      });
      it('should fail if user tries to unstake more than his balance', async function () {
        await invokeRebase(ham, +50);
        await expectRevert(
          dist.unstake($HAM(85), [], { from: anotherAccount }),
          'TokenGeyser: unstake amount is greater than total user stakes'
        );
      });
      it('should NOT fail if user tries to unstake his balance', async function () {
        await invokeRebase(ham, +50);
        await dist.unstake($HAM(75), [], { from: anotherAccount });
      });
      it('should fail if there are too few stakingSharesToBurn', async function () {
        await invokeRebase(ham, 100 * InitialSharesPerToken);
        await expectRevert(
          dist.unstake(1, [], { from: anotherAccount }),
          'TokenGeyser: Unable to unstake amount this small'
        );
      });
    });

    describe('when rebase decreases supply', function () {
      beforeEach(async function () {
        await dist.stake($HAM(50), [], { from: anotherAccount });
        await time.increase(1);
      });
      it('should fail if user tries to unstake more than his balance', async function () {
        await invokeRebase(ham, -50);
        await expectRevert(
          dist.unstake($HAM(50), [], { from: anotherAccount }),
          'TokenGeyser: unstake amount is greater than total user stakes'
        );
      });
      it('should NOT fail if user tries to unstake his balance', async function () {
        await invokeRebase(ham, -50);
        await dist.unstake($HAM(25), [], { from: anotherAccount });
      });
    });

    describe('when single user stakes once', function () {
      // 100 hams locked for 1 year, user stakes 50 hams for 1 year
      // user is eligible for 100% of the reward,
      // unstakes 30 hams, gets 60% of the reward (60 ham)
      // user's final balance is 90 ham, (20 remains staked), eligible rewards (40 ham)
      const timeController = new TimeController();
      beforeEach(async function () {
        await dist.lockTokens($HAM(100), ONE_YEAR);
        await timeController.initialize();
        await dist.stake($HAM(50), [], { from: anotherAccount });
        await timeController.advanceTime(ONE_YEAR);
        await dist.updateAccounting({ from: anotherAccount });
        checkHamAprox(await totalRewardsFor(anotherAccount), 100);
      });
      it('should update the total staked and rewards', async function () {
        await dist.unstake($HAM(30), [], { from: anotherAccount });
        expect(await dist.totalStaked.call()).to.be.bignumber.equal($HAM(20));
        expect(await dist.totalStakedFor.call(anotherAccount)).to.be.bignumber.equal($HAM(20));
        checkHamAprox(await totalRewardsFor(anotherAccount), 40);
      });
      it('should transfer back staked tokens + rewards', async function () {
        const _b = await ham.balanceOf.call(anotherAccount);
        await dist.unstake($HAM(30), [], { from: anotherAccount });
        const b = await ham.balanceOf.call(anotherAccount);
        checkHamAprox(b.sub(_b), 90);
      });
      it('should log Unstaked', async function () {
        const r = await dist.unstake($HAM(30), [], { from: anotherAccount });
        expectEvent(r, 'Unstaked', {
          user: anotherAccount,
          amount: $HAM(30),
          total: $HAM(20)
        });
      });
      it('should log TokensClaimed', async function () {
        const r = await dist.unstake($HAM(30), [], { from: anotherAccount });
        expectEvent(r, 'TokensClaimed', {
          user: anotherAccount,
          amount: $HAM(60)
        });
      });
    });

    describe('when single user unstake early with early bonus', function () {
      // Start bonus = 50%, Bonus Period = 1 Day.
      // 1000 hams locked for 1 hour, so all will be unlocked by test-time.
      // user stakes 500 hams for 12 hours, half the period.
      // user is eligible for 75% of the max reward,
      // unstakes 250 hams, gets .5 * .75 * 1000 hams
      // user's final balance is 625 ham, (250 remains staked), eligible rewards (375 ham)
      const timeController = new TimeController();
      const ONE_HOUR = 3600;
      beforeEach(async function () {
        await dist.lockTokens($HAM(1000), ONE_HOUR);
        timeController.initialize();
        await dist.stake($HAM(500), [], { from: anotherAccount });
        await timeController.advanceTime(12 * ONE_HOUR);
        await dist.updateAccounting({ from: anotherAccount });
        checkHamAprox(await totalRewardsFor(anotherAccount), 1000);
      });
      it('should update the total staked and rewards', async function () {
        await dist.unstake($HAM(250), [], { from: anotherAccount });
        expect(await dist.totalStaked.call()).to.be.bignumber.equal($HAM(250));
        expect(await dist.totalStakedFor.call(anotherAccount)).to.be.bignumber.equal($HAM(250));
        checkHamAprox(await totalRewardsFor(anotherAccount), 625); // (.5 * .75 * 1000) + 250
      });
      it('should transfer back staked tokens + rewards', async function () {
        const _b = await ham.balanceOf.call(anotherAccount);
        await dist.unstake($HAM(250), [], { from: anotherAccount });
        const b = await ham.balanceOf.call(anotherAccount);
        checkHamAprox(b.sub(_b), 625);
      });
      it('should log Unstaked', async function () {
        const r = await dist.unstake($HAM(250), [], { from: anotherAccount });
        expectEvent(r, 'Unstaked', {
          user: anotherAccount,
          amount: $HAM(250),
          total: $HAM(250)
        });
      });
      it('should log TokensClaimed', async function () {
        const r = await dist.unstake($HAM(250), [], { from: anotherAccount });
        expectEvent(r, 'TokensClaimed', {
          user: anotherAccount,
          amount: $HAM(375) // .5 * .75 * 1000
        });
      });
    });

    describe('when single user stakes many times', function () {
      // 100 hams locked for 1 year,
      // user stakes 50 hams for 1/2 year, 50 hams for 1/4 year, [50 hams unlocked in this time ]
      // unstakes 30 hams, gets 20% of the unlocked reward (10 ham) ~ [30 * 0.25 / (50*0.25+50*0.5) * 50]
      // user's final balance is 40 ham
      const timeController = new TimeController();
      beforeEach(async function () {
        await dist.lockTokens($HAM(100), ONE_YEAR);
        await timeController.initialize();
        await timeController.advanceTime(ONE_YEAR / 100);
        await dist.stake($HAM(50), [], { from: anotherAccount });
        await timeController.initialize();
        await timeController.advanceTime(ONE_YEAR / 4);
        await dist.stake($HAM(50), [], { from: anotherAccount });
        await timeController.advanceTime(ONE_YEAR / 4);
        await dist.updateAccounting({ from: anotherAccount });
      });
      it('checkTotalRewards', async function () {
        checkHamAprox(await totalRewardsFor(anotherAccount), 51);
      });
      it('should update the total staked and rewards', async function () {
        await dist.unstake($HAM(30), [], { from: anotherAccount });
        expect(await dist.totalStaked.call()).to.be.bignumber.equal($HAM(70));
        expect(await dist.totalStakedFor.call(anotherAccount)).to.be.bignumber.equal($HAM(70));
        checkHamAprox(await totalRewardsFor(anotherAccount), 40.8);
      });
      it('should transfer back staked tokens + rewards', async function () {
        const _b = await ham.balanceOf.call(anotherAccount);
        await dist.unstake($HAM(30), [], { from: anotherAccount });
        const b = await ham.balanceOf.call(anotherAccount);
        checkHamAprox(b.sub(_b), 40.2);
      });
    });

    describe('when single user performs unstake many times', function () {
      // 100 hams locked for 1 year,
      // user stakes 10 hams, waits 1 year, stakes 10 hams, waits 1 year,
      // unstakes 5 ham, unstakes 5 ham, unstakes 5 ham
      // 3rd unstake should be worth twice the first one
      const timeController = new TimeController();
      beforeEach(async function () {
        await dist.lockTokens($HAM(100), ONE_YEAR);
        await timeController.initialize();
        await dist.stake($HAM(10), [], { from: anotherAccount });
        await timeController.advanceTime(ONE_YEAR);
        await dist.stake($HAM(10), [], { from: anotherAccount });
        await timeController.advanceTime(ONE_YEAR);
        await dist.updateAccounting({ from: anotherAccount });
        checkHamAprox(await totalRewardsFor(anotherAccount), 100);
      });

      it('should use updated user accounting', async function () {
        const r1 = await dist.unstake($HAM(5), [], { from: anotherAccount });
        expectEvent(r1, 'TokensClaimed', {
          user: anotherAccount
        });
        const l1 = r1.logs.filter(l => l.event === 'TokensClaimed')[0];
        const claim1 = l1.args.amount;
        const r2 = await dist.unstake($HAM(5), [], { from: anotherAccount });
        expectEvent(r2, 'TokensClaimed', {
          user: anotherAccount
        });
        const r3 = await dist.unstake($HAM(5), [], { from: anotherAccount });
        expectEvent(r3, 'TokensClaimed', {
          user: anotherAccount
        });
        const l3 = r3.logs.filter(l => l.event === 'TokensClaimed')[0];
        const claim3 = l3.args.amount;
        const ratio = claim3.mul(new BN(100)).div(claim1);
        expect(ratio).to.be.bignumber.gte('199').and.bignumber.below('201');
      });
    });

    describe('when multiple users stake once', function () {
      // 100 hams locked for 1 year,
      // userA stakes 50 hams for 3/4 year, userb stakes 50 ham for 1/2 year, total unlocked 75 ham
      // userA unstakes 30 hams, gets 36% of the unlocked reward (27 ham) ~ [30 * 0.75 / (50*0.75+50*0.5) * 75]
      // user's final balance is 57 ham
      const timeController = new TimeController();
      beforeEach(async function () {
        await dist.lockTokens($HAM(100), ONE_YEAR);
        await timeController.initialize();
        await timeController.advanceTime(ONE_YEAR / 100);
        await dist.stake($HAM(50), [], { from: anotherAccount });
        await timeController.initialize();
        await timeController.advanceTime(ONE_YEAR / 4);
        await dist.stake($HAM(50), []);
        await timeController.advanceTime(ONE_YEAR / 2);
        await dist.updateAccounting({ from: anotherAccount });
        await dist.updateAccounting();
        expect(await dist.totalStaked.call()).to.be.bignumber.equal($HAM(100));
        checkHamAprox(await totalRewardsFor(anotherAccount), 45.6);
        checkHamAprox(await totalRewardsFor(owner), 30.4);
      });
      it('checkTotalRewards', async function () {
        expect(await dist.totalStaked.call()).to.be.bignumber.equal($HAM(100));
        checkHamAprox(await totalRewardsFor(anotherAccount), 45.6);
        checkHamAprox(await totalRewardsFor(owner), 30.4);
      });
      it('should update the total staked and rewards', async function () {
        await dist.unstake($HAM(30), [], { from: anotherAccount });
        expect(await dist.totalStaked.call()).to.be.bignumber.equal($HAM(70));
        expect(await dist.totalStakedFor.call(anotherAccount)).to.be.bignumber.equal($HAM(20));
        expect(await dist.totalStakedFor.call(owner)).to.be.bignumber.equal($HAM(50));
        checkHamAprox(await totalRewardsFor(anotherAccount), 18.24);
        checkHamAprox(await totalRewardsFor(owner), 30.4);
      });
      it('should transfer back staked tokens + rewards', async function () {
        const _b = await ham.balanceOf.call(anotherAccount);
        await dist.unstake($HAM(30), [], { from: anotherAccount });
        const b = await ham.balanceOf.call(anotherAccount);
        checkHamAprox(b.sub(_b), 57.36);
      });
    });

    describe('when multiple users stake many times', function () {
      // 10000 hams locked for 1 year,
      // userA stakes 5000 hams for 3/4 year, and 5000 hams for 1/4 year
      // userb stakes 5000 hams for 1/2 year and 3000 hams for 1/4 year
      // userA unstakes 10000 hams, gets 60.60% of the unlocked reward (4545 ham)
      //        ~ [5000*0.75+5000*0.25 / (5000*0.75+5000*0.25+5000*0.5+3000*0.25) * 7500]
      // user's final balance is 14545 ham
      // userb unstakes 8000 hams, gets the 10955 ham
      const timeController = new TimeController();
      const rewardsAnotherAccount = 50000.0 / 11.0;
      const rewardsOwner = 32500.0 / 11.0;
      beforeEach(async function () {
        await timeController.executeAsBlock(function () {
          dist.lockTokens($HAM(10000), ONE_YEAR);
          dist.stake($HAM(5000), [], { from: anotherAccount });
        });
        await timeController.initialize();
        await timeController.advanceTime(ONE_YEAR / 4);
        await dist.stake($HAM(5000), []);
        await timeController.advanceTime(ONE_YEAR / 4);
        await dist.stake($HAM(5000), [], { from: anotherAccount });
        await dist.stake($HAM(3000), []);
        await timeController.advanceTime(ONE_YEAR / 4);
        await dist.updateAccounting({ from: anotherAccount });
        await dist.updateAccounting();
        expect(await dist.totalStaked.call()).to.be.bignumber.equal($HAM(18000));
        checkHamAprox(await totalRewardsFor(anotherAccount), rewardsAnotherAccount);
        checkHamAprox(await totalRewardsFor(owner), rewardsOwner);
      });
      it('should update the total staked and rewards', async function () {
        await dist.unstake($HAM(10000), [], { from: anotherAccount });
        expect(await dist.totalStaked.call()).to.be.bignumber.equal($HAM(8000));
        expect(await dist.totalStakedFor.call(anotherAccount)).to.be.bignumber.equal($HAM(0));
        expect(await dist.totalStakedFor.call(owner)).to.be.bignumber.equal($HAM(8000));
        checkHamAprox(await totalRewardsFor(anotherAccount), 0);
        checkHamAprox(await totalRewardsFor(owner), rewardsOwner);
        await dist.unstake($HAM(8000), []);
        expect(await dist.totalStaked.call()).to.be.bignumber.equal($HAM(0));
        expect(await dist.totalStakedFor.call(anotherAccount)).to.be.bignumber.equal($HAM(0));
        expect(await dist.totalStakedFor.call(owner)).to.be.bignumber.equal($HAM(0));
        checkHamAprox(await totalRewardsFor(anotherAccount), 0);
        checkHamAprox(await totalRewardsFor(owner), 0);
      });
      it('should transfer back staked tokens + rewards', async function () {
        const b1 = await ham.balanceOf.call(anotherAccount);
        await dist.unstake($HAM(10000), [], { from: anotherAccount });
        const b2 = await ham.balanceOf.call(anotherAccount);
        checkHamAprox(b2.sub(b1), 10000 + rewardsAnotherAccount);
        const b3 = await ham.balanceOf.call(owner);
        await dist.unstake($HAM(8000), []);
        const b4 = await ham.balanceOf.call(owner);
        checkHamAprox(b4.sub(b3), 8000 + rewardsOwner);
      });
    });
  });

  describe('unstakeQuery', function () {
    // 100 hams locked for 1 year, user stakes 50 hams for 1 year
    // user is eligible for 100% of the reward,
    // unstakes 30 hams, gets 60% of the reward (60 ham)
    const timeController = new TimeController();
    beforeEach(async function () {
      await dist.lockTokens($HAM(100), ONE_YEAR);
      await dist.stake($HAM(50), [], { from: anotherAccount });
      await timeController.initialize();
      await timeController.advanceTime(ONE_YEAR);
      await dist.updateAccounting({ from: anotherAccount });
    });
    it('should return the reward amount', async function () {
      checkHamAprox(await totalRewardsFor(anotherAccount), 100);
      const a = await dist.unstakeQuery.call($HAM(30), { from: anotherAccount });
      checkHamAprox(a, 60);
    });
  });
});
