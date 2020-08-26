const { contract, web3 } = require('@openzeppelin/test-environment');
const { expectRevert, BN, time, constants } = require('@openzeppelin/test-helpers');
const { expect } = require('chai');

const _require = require('app-root-path').require;
const BlockchainCaller = _require('/util/blockchain_caller');
const chain = new BlockchainCaller(web3);
const {
  $HAM,
  invokeRebase,
  checkHamAprox,
  checkSharesAprox,
  setTimeForNextTransaction,
  TimeController
} = _require('/test/helper');

const HamErc20 = contract.fromArtifact('UFragments');
const TokenGeyser = contract.fromArtifact('TokenGeyser');

const ONE_YEAR = 365 * 24 * 3600;
const START_BONUS = 50;
const BONUS_PERIOD = 86400;
const InitialSharesPerToken = 10 ** 6;

let ham, dist, owner, anotherAccount;
async function setupContractAndAccounts () {
  const accounts = await chain.getUserAccounts();
  owner = web3.utils.toChecksumAddress(accounts[0]);
  anotherAccount = web3.utils.toChecksumAddress(accounts[8]);

  ham = await HamErc20.new();
  await ham.initialize(owner);
  await ham.setMonetaryPolicy(owner);

  dist = await TokenGeyser.new(ham.address, ham.address, 10, START_BONUS, BONUS_PERIOD,
    InitialSharesPerToken);
}

async function checkAvailableToUnlock (dist, v) {
  const u = await dist.totalUnlocked.call();
  const r = await dist.updateAccounting.call();
  // console.log('Total unlocked: ', u.toString(), 'total unlocked after: ', r[1].toString());
  checkHamAprox(r[1].sub(u), v);
}

describe('LockedPool', function () {
  beforeEach('setup contracts', async function () {
    await setupContractAndAccounts();
  });

  describe('getDistributionToken', function () {
    it('should return the staking token', async function () {
      expect(await dist.getDistributionToken.call()).to.equal(ham.address);
    });
  });

  describe('lockTokens', function () {
    describe('when not approved', function () {
      it('should fail', async function () {
        const d = await TokenGeyser.new(ham.address, ham.address, 5, START_BONUS, BONUS_PERIOD, InitialSharesPerToken);
        await expectRevert.unspecified(d.lockTokens($HAM(10), ONE_YEAR));
      });
    });

    describe('when number of unlock schedules exceeds the maxUnlockSchedules', function () {
      it('should fail', async function () {
        const d = await TokenGeyser.new(ham.address, ham.address, 5, START_BONUS, BONUS_PERIOD, InitialSharesPerToken);
        await ham.approve(d.address, $HAM(100));
        await d.lockTokens($HAM(10), ONE_YEAR);
        await d.lockTokens($HAM(10), ONE_YEAR);
        await d.lockTokens($HAM(10), ONE_YEAR);
        await d.lockTokens($HAM(10), ONE_YEAR);
        await d.lockTokens($HAM(10), ONE_YEAR);
        await expectRevert(d.lockTokens($HAM(10), ONE_YEAR),
          'TokenGeyser: reached maximum unlock schedules');
      });
    });

    describe('when totalLocked=0', function () {
      beforeEach(async function () {
        checkHamAprox(await dist.totalLocked.call(), 0);
        await ham.approve(dist.address, $HAM(100));
      });
      it('should updated the locked pool balance', async function () {
        await dist.lockTokens($HAM(100), ONE_YEAR);
        checkHamAprox(await dist.totalLocked.call(), 100);
      });
      it('should create a schedule', async function () {
        await dist.lockTokens($HAM(100), ONE_YEAR);
        const s = await dist.unlockSchedules.call(0);
        expect(s[0]).to.be.bignumber.equal($HAM(100).mul(new BN(InitialSharesPerToken)));
        expect(s[1]).to.be.bignumber.equal($HAM(0));
        expect(s[2].add(s[4])).to.be.bignumber.equal(s[3]);
        expect(s[4]).to.be.bignumber.equal(`${ONE_YEAR}`);
        expect(await dist.unlockScheduleCount.call()).to.be.bignumber.equal('1');
      });
      it('should log TokensLocked', async function () {
        const r = await dist.lockTokens($HAM(100), ONE_YEAR);
        const l = r.logs.filter(l => l.event === 'TokensLocked')[0];
        checkHamAprox(l.args.amount, 100);
        checkHamAprox(l.args.total, 100);
        expect(l.args.durationSec).to.be.bignumber.equal(`${ONE_YEAR}`);
      });
      it('should be protected', async function () {
        await ham.approve(dist.address, $HAM(100));
        await expectRevert(dist.lockTokens($HAM(50), ONE_YEAR, { from: anotherAccount }),
          'Ownable: caller is not the owner');
        await dist.lockTokens($HAM(50), ONE_YEAR);
      });
    });

    describe('when totalLocked>0', function () {
      const timeController = new TimeController();
      beforeEach(async function () {
        await ham.approve(dist.address, $HAM(150));
        await dist.lockTokens($HAM(100), ONE_YEAR);
        await timeController.initialize();
        checkHamAprox(await dist.totalLocked.call(), 100);
      });
      it('should updated the locked and unlocked pool balance', async function () {
        await timeController.advanceTime(ONE_YEAR / 10);
        await dist.lockTokens($HAM(50), ONE_YEAR);
        checkHamAprox(await dist.totalLocked.call(), 100 * 0.9 + 50);
      });
      it('should log TokensUnlocked and TokensLocked', async function () {
        await timeController.advanceTime(ONE_YEAR / 10);
        const r = await dist.lockTokens($HAM(50), ONE_YEAR);

        let l = r.logs.filter(l => l.event === 'TokensUnlocked')[0];
        checkHamAprox(l.args.amount, 100 * 0.1);
        checkHamAprox(l.args.total, 100 * 0.9);

        l = r.logs.filter(l => l.event === 'TokensLocked')[0];
        checkHamAprox(l.args.amount, 50);
        checkHamAprox(l.args.total, 100 * 0.9 + 50);
        expect(l.args.durationSec).to.be.bignumber.equal(`${ONE_YEAR}`);
      });
      it('should create a schedule', async function () {
        await timeController.advanceTime(ONE_YEAR / 10);
        await dist.lockTokens($HAM(50), ONE_YEAR);
        const s = await dist.unlockSchedules.call(1);
        // struct UnlockSchedule {
        // 0   uint256 initialLockedShares;
        // 1   uint256 unlockedShares;
        // 2   uint256 lastUnlockTimestampSec;
        // 3   uint256 endAtSec;
        // 4   uint256 durationSec;
        // }
        checkSharesAprox(s[0], $HAM(50).mul(new BN(InitialSharesPerToken)));
        checkSharesAprox(s[1], new BN(0));
        expect(s[2].add(s[4])).to.be.bignumber.equal(s[3]);
        expect(s[4]).to.be.bignumber.equal(`${ONE_YEAR}`);
        expect(await dist.unlockScheduleCount.call()).to.be.bignumber.equal('2');
      });
    });

    describe('when totalLocked>0, rebase increases supply', function () {
      const timeController = new TimeController();
      beforeEach(async function () {
        await ham.approve(dist.address, $HAM(150));
        await dist.lockTokens($HAM(100), ONE_YEAR);
        await timeController.initialize();
        checkHamAprox(await dist.totalLocked.call(), 100);
        await invokeRebase(ham, 100);
      });
      it('should updated the locked pool balance', async function () {
        await timeController.advanceTime(ONE_YEAR / 10);
        await dist.lockTokens($HAM(50), ONE_YEAR);
        checkHamAprox(await dist.totalLocked.call(), 50 + 200 * 0.9);
      });
      it('should updated the locked pool balance', async function () {
        await timeController.advanceTime(ONE_YEAR / 10);
        await dist.lockTokens($HAM(50), ONE_YEAR);

        checkHamAprox(await dist.totalLocked.call(), 50 + 200 * 0.9);
      });
      it('should log TokensUnlocked and TokensLocked', async function () {
        await timeController.advanceTime(ONE_YEAR / 10);
        const r = await dist.lockTokens($HAM(50), ONE_YEAR);
        let l = r.logs.filter(l => l.event === 'TokensUnlocked')[0];
        checkHamAprox(l.args.amount, 200 * 0.1);
        checkHamAprox(l.args.total, 200 * 0.9);

        l = r.logs.filter(l => l.event === 'TokensLocked')[0];
        checkHamAprox(l.args.amount, 50);
        checkHamAprox(l.args.total, 50.0 + 200.0 * 0.9);
        expect(l.args.durationSec).to.be.bignumber.equal(`${ONE_YEAR}`);
      });
      it('should create a schedule', async function () {
        await timeController.advanceTime(ONE_YEAR / 10);
        await dist.lockTokens($HAM(50), ONE_YEAR);
        const s = await dist.unlockSchedules.call(1);
        checkSharesAprox(s[0], $HAM(25).mul(new BN(InitialSharesPerToken)));
        checkSharesAprox(s[1], new BN(0));
        expect(s[2].add(s[4])).to.be.bignumber.equal(s[3]);
        expect(s[4]).to.be.bignumber.equal(`${ONE_YEAR}`);
        expect(await dist.unlockScheduleCount.call()).to.be.bignumber.equal('2');
      });
    });

    describe('when totalLocked>0, rebase decreases supply', function () {
      let currentTime;
      beforeEach(async function () {
        await ham.approve(dist.address, $HAM(150));
        await dist.lockTokens($HAM(100), ONE_YEAR);
        currentTime = await time.latest();
        checkHamAprox(await dist.totalLocked.call(), 100);
        await invokeRebase(ham, -50);
      });
      it('should updated the locked pool balance', async function () {
        await dist.lockTokens($HAM(50), ONE_YEAR);
        checkHamAprox(await dist.totalLocked.call(), 100);
      });
      it('should log TokensUnlocked and TokensLocked', async function () {
        currentTime = currentTime.add(new BN(ONE_YEAR / 10));
        await setTimeForNextTransaction(currentTime);
        const r = await dist.lockTokens($HAM(50), ONE_YEAR);
        let l = r.logs.filter(l => l.event === 'TokensUnlocked')[0];
        checkHamAprox(l.args.amount, 50 * 0.1);
        checkHamAprox(l.args.total, 50 * 0.9);

        l = r.logs.filter(l => l.event === 'TokensLocked')[0];
        checkHamAprox(l.args.amount, 50);
        checkHamAprox(l.args.total, 50 * 0.9 + 50);
        expect(l.args.durationSec).to.be.bignumber.equal(`${ONE_YEAR}`);
      });
      it('should create a schedule', async function () {
        await dist.lockTokens($HAM(50), ONE_YEAR);
        const s = await dist.unlockSchedules.call(1);

        checkSharesAprox(s[0], $HAM(100).mul(new BN(InitialSharesPerToken)));
        expect(s[1]).to.be.bignumber.equal($HAM(0));
        expect(s[2].add(s[4])).to.be.bignumber.equal(s[3]);
        expect(s[4]).to.be.bignumber.equal(`${ONE_YEAR}`);
        expect(await dist.unlockScheduleCount.call()).to.be.bignumber.equal('2');
      });
    });
  });

  describe('unlockTokens', function () {
    describe('single schedule', function () {
      describe('after waiting for 1/2 the duration', function () {
        const timeController = new TimeController();
        beforeEach(async function () {
          await ham.approve(dist.address, $HAM(100));
          await dist.lockTokens($HAM(100), ONE_YEAR);
          await timeController.initialize();
          await timeController.advanceTime(ONE_YEAR / 2);
        });

        describe('when supply is unchanged', function () {
          it('should unlock 1/2 the tokens', async function () {
            await timeController.executeEmptyBlock();
            expect(await dist.totalLocked.call()).to.be.bignumber.equal($HAM(100));
            expect(await dist.totalUnlocked.call()).to.be.bignumber.equal($HAM(0));
            await checkAvailableToUnlock(dist, 50);
          });
          it('should transfer tokens to unlocked pool', async function () {
            await dist.updateAccounting();
            checkHamAprox(await dist.totalLocked.call(), 50);
            checkHamAprox(await dist.totalUnlocked.call(), 50);
            await checkAvailableToUnlock(dist, 0);
          });
          it('should log TokensUnlocked and update state', async function () {
            const r = await dist.updateAccounting();
            const l = r.logs.filter(l => l.event === 'TokensUnlocked')[0];
            checkHamAprox(l.args.amount, 50);
            checkHamAprox(l.args.total, 50);
            const s = await dist.unlockSchedules(0);
            expect(s[0]).to.be.bignumber.equal($HAM(100).mul(new BN(InitialSharesPerToken)));
            checkSharesAprox(s[1], $HAM(50).mul(new BN(InitialSharesPerToken)));
          });
        });

        describe('when rebase increases supply', function () {
          beforeEach(async function () {
            await invokeRebase(ham, 100);
          });
          it('should unlock 1/2 the tokens', async function () {
            await timeController.executeEmptyBlock();
            expect(await dist.totalLocked.call()).to.be.bignumber.equal($HAM(200));
            expect(await dist.totalUnlocked.call()).to.be.bignumber.equal($HAM(0));
            await checkAvailableToUnlock(dist, 100);
          });
          it('should transfer tokens to unlocked pool', async function () {
            // printStatus(dist);
            await dist.updateAccounting();

            checkHamAprox(await dist.totalLocked.call(), 100);
            checkHamAprox(await dist.totalUnlocked.call(), 100);
            await checkAvailableToUnlock(dist, 0);
          });
        });

        describe('when rebase decreases supply', function () {
          beforeEach(async function () {
            await invokeRebase(ham, -50);
          });
          it('should unlock 1/2 the tokens', async function () {
            expect(await dist.totalLocked.call()).to.be.bignumber.equal($HAM(50));
            await checkAvailableToUnlock(dist, 25);
          });
          it('should transfer tokens to unlocked pool', async function () {
            expect(await dist.totalLocked.call()).to.be.bignumber.equal($HAM(50));
            expect(await dist.totalUnlocked.call()).to.be.bignumber.equal($HAM(0));
            await dist.updateAccounting();

            checkHamAprox(await dist.totalLocked.call(), 25);
            checkHamAprox(await dist.totalUnlocked.call(), 25);
            await checkAvailableToUnlock(dist, 0);
          });
        });
      });

      describe('after waiting > the duration', function () {
        beforeEach(async function () {
          await ham.approve(dist.address, $HAM(100));
          await dist.lockTokens($HAM(100), ONE_YEAR);
          await time.increase(2 * ONE_YEAR);
        });
        it('should unlock all the tokens', async function () {
          await checkAvailableToUnlock(dist, 100);
        });
        it('should transfer tokens to unlocked pool', async function () {
          expect(await dist.totalLocked.call()).to.be.bignumber.equal($HAM(100));
          expect(await dist.totalUnlocked.call()).to.be.bignumber.equal($HAM(0));
          await dist.updateAccounting();
          expect(await dist.totalLocked.call()).to.be.bignumber.equal($HAM(0));
          checkHamAprox(await dist.totalUnlocked.call(), 100);
          await checkAvailableToUnlock(dist, 0);
        });
        it('should log TokensUnlocked and update state', async function () {
          const r = await dist.updateAccounting();
          const l = r.logs.filter(l => l.event === 'TokensUnlocked')[0];
          checkHamAprox(l.args.amount, 100);
          checkHamAprox(l.args.total, 0);
          const s = await dist.unlockSchedules(0);
          expect(s[0]).to.be.bignumber.equal($HAM(100).mul(new BN(InitialSharesPerToken)));
          expect(s[1]).to.be.bignumber.equal($HAM(100).mul(new BN(InitialSharesPerToken)));
        });
      });

      describe('dust tokens due to division underflow', function () {
        beforeEach(async function () {
          await ham.approve(dist.address, $HAM(100));
          await dist.lockTokens($HAM(1), 10 * ONE_YEAR);
        });
        it('should unlock all tokens', async function () {
          // 1 HAM locked for 10 years. Almost all time passes upto the last minute.
          // 0.999999809 HAMs are unlocked.
          // 1 minute passes, Now: all of the rest are unlocked: 191
          // before (#24): only 190 would have been unlocked and 0.000000001 HAM would be
          // locked.
          await time.increase(10 * ONE_YEAR - 60);
          const r1 = await dist.updateAccounting();
          const l1 = r1.logs.filter(l => l.event === 'TokensUnlocked')[0];
          await time.increase(65);
          const r2 = await dist.updateAccounting();
          const l2 = r2.logs.filter(l => l.event === 'TokensUnlocked')[0];
          expect(l1.args.amount.add(l2.args.amount)).to.be.bignumber.equal($HAM(1));
        });
      });
    });

    describe('multi schedule', function () {
      const timeController = new TimeController();
      beforeEach(async function () {
        await ham.approve(dist.address, $HAM(200));
        await dist.lockTokens($HAM(100), ONE_YEAR);
        await timeController.initialize();
        await timeController.advanceTime(ONE_YEAR / 2);
        await dist.lockTokens($HAM(100), ONE_YEAR);
        await timeController.advanceTime(ONE_YEAR / 10);
      });
      it('should return the remaining unlock value', async function () {
        await time.advanceBlock();
        expect(await dist.totalLocked.call()).to.be.bignumber.equal($HAM(150));
        expect(await dist.totalUnlocked.call()).to.be.bignumber.equal($HAM(50));
        // 10 from each schedule for the period of ONE_YEAR / 10

        await checkAvailableToUnlock(dist, 20);
      });
      it('should transfer tokens to unlocked pool', async function () {
        await dist.updateAccounting();
        checkHamAprox(await dist.totalLocked.call(), 130);
        checkHamAprox(await dist.totalUnlocked.call(), 70);
        await checkAvailableToUnlock(dist, 0);
      });
      it('should log TokensUnlocked and update state', async function () {
        const r = await dist.updateAccounting();

        const l = r.logs.filter(l => l.event === 'TokensUnlocked')[0];
        checkHamAprox(l.args.amount, 20);
        checkHamAprox(l.args.total, 130);

        const s1 = await dist.unlockSchedules(0);
        checkSharesAprox(s1[0], $HAM(100).mul(new BN(InitialSharesPerToken)));
        checkSharesAprox(s1[1], $HAM(60).mul(new BN(InitialSharesPerToken)));
        const s2 = await dist.unlockSchedules(1);
        checkSharesAprox(s2[0], $HAM(100).mul(new BN(InitialSharesPerToken)));
        checkSharesAprox(s2[1], $HAM(10).mul(new BN(InitialSharesPerToken)));
      });
      it('should continue linear the unlock', async function () {
        await dist.updateAccounting();
        await timeController.advanceTime(ONE_YEAR / 5);
        await dist.updateAccounting();

        checkHamAprox(await dist.totalLocked.call(), 90);
        checkHamAprox(await dist.totalUnlocked.call(), 110);
        await checkAvailableToUnlock(dist, 0);
        await timeController.advanceTime(ONE_YEAR / 5);
        await dist.updateAccounting();

        checkHamAprox(await dist.totalLocked.call(), 50);
        checkHamAprox(await dist.totalUnlocked.call(), 150);
        await checkAvailableToUnlock(dist, 0);
      });
    });
  });

  describe('updateAccounting', function () {
    let _r, _t;
    beforeEach(async function () {
      _r = await dist.updateAccounting.call({ from: owner });
      _t = await time.latest();
      await ham.approve(dist.address, $HAM(300));
      await dist.stake($HAM(100), []);
      await dist.lockTokens($HAM(100), ONE_YEAR);
      await time.increase(ONE_YEAR / 2);
      await dist.lockTokens($HAM(100), ONE_YEAR);
      await time.increase(ONE_YEAR / 10);
    });

    describe('when user history does exist', async function () {
      it('should return the system state', async function () {
        const r = await dist.updateAccounting.call({ from: owner });
        const t = await time.latest();
        checkHamAprox(r[0], 130);
        checkHamAprox(r[1], 70);
        const timeElapsed = t.sub(_t);
        expect(r[2].div(new BN(100e9).mul(new BN(InitialSharesPerToken)))).to.be
          .bignumber.above(timeElapsed.sub(new BN(5))).and
          .bignumber.below(timeElapsed.add(new BN(5)));
        expect(r[3].div(new BN(100e9).mul(new BN(InitialSharesPerToken)))).to.be
          .bignumber.above(timeElapsed.sub(new BN(5))).and
          .bignumber.below(timeElapsed.add(new BN(5)));
        checkHamAprox(r[4], 70);
        checkHamAprox(r[4], 70);
        const delta = new BN(r[5]).sub(new BN(_r[5]));
        expect(delta).to.be
          .bignumber.above(timeElapsed.sub(new BN(1))).and
          .bignumber.below(timeElapsed.add(new BN(1)));
      });
    });

    describe('when user history does not exist', async function () {
      it('should return the system state', async function () {
        const r = await dist.updateAccounting.call({ from: constants.ZERO_ADDRESS });
        const t = await time.latest();
        checkHamAprox(r[0], 130);
        checkHamAprox(r[1], 70);
        const timeElapsed = t.sub(_t);
        expect(r[2].div(new BN(100e9).mul(new BN(InitialSharesPerToken)))).to.be.bignumber.equal('0');
        expect(r[3].div(new BN(100e9).mul(new BN(InitialSharesPerToken)))).to.be
          .bignumber.above(timeElapsed.sub(new BN(5))).and
          .bignumber.below(timeElapsed.add(new BN(5)));
        checkHamAprox(r[4], 0);
        const delta = new BN(r[5]).sub(new BN(_r[5]));
        expect(delta).to.be
          .bignumber.above(timeElapsed.sub(new BN(1))).and
          .bignumber.below(timeElapsed.add(new BN(1)));
      });
    });
  });
});
