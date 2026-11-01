// End-to-end tests for the browser half of the adapter, in a real browser.
//
// The Node half is covered thoroughly by test/task.test.js. What only real Cypress
// can prove is the part that is easy to get wrong and impossible to check against a
// stub: that axe-core actually injects into the page, that the command chain yields
// the right value, and that a failure surfaces as a test failure rather than an
// unhandled rejection.

const BASELINE = 'cypress/.tmp-baseline.json';

describe('cy.skiplinkScan', () => {
  beforeEach(() => cy.visit('/'));

  it('finds the deliberate failures and names the rules', () => {
    cy.skiplinkScan().then((result) => {
      const rules = result.violations.map((v) => v.rule);
      expect(rules).to.include('color-contrast');
      expect(rules).to.include('image-alt');
      expect(rules).to.include('link-name');

      expect(result.status).to.equal('done');
      expect(result.standard).to.equal('wcag22aa');
      expect(result.engine.axe_core).to.match(/^\d+\.\d+\.\d+/);
      expect(result.passes).to.be.greaterThan(0);
      expect(result.score).to.be.within(0, 100);
    });
  });

  it('gives BEM siblings different fingerprints', () => {
    // Both headings fail contrast. If they shared a fingerprint, a baseline entry
    // for one would absorb a new violation on the other and the gate would go
    // green on a broken page.
    cy.skiplinkScan().then((result) => {
      const contrast = result.violations.filter((v) => v.rule === 'color-contrast');
      expect(contrast).to.have.length.of.at.least(2);
      const prints = new Set(contrast.map((v) => v.fingerprint));
      expect(prints.size).to.equal(contrast.length);
    });
  });

  it('include narrows the scan', () => {
    cy.skiplinkScan().then((all) => {
      cy.skiplinkScan({ include: '.hero__title' }).then((narrowed) => {
        expect(narrowed.violations.length).to.be.lessThan(all.violations.length);
        narrowed.violations.forEach((v) => expect(v.rule).to.equal('color-contrast'));
      });
    });
  });

  it('disableRules turns a rule off', () => {
    cy.skiplinkScan({ disableRules: ['color-contrast'] }).then((result) => {
      expect(result.violations.map((v) => v.rule)).to.not.include('color-contrast');
      expect(result.violations.length).to.be.greaterThan(0);
    });
  });

  it('refuses an unknown standard instead of scanning everything', () => {
    // axe reads an empty tag list as "every rule", so a typo must be an error.
    cy.on('fail', (err) => {
      expect(err.message).to.match(/Unknown standard/);
      return false;
    });
    cy.skiplinkScan({ standard: 'wcag99zz' });
  });
});

describe('cy.checkA11y', () => {
  beforeEach(() => cy.visit('/'));

  it('fails when there is no baseline, listing the violations', () => {
    cy.on('fail', (err) => {
      expect(err.message).to.match(/accessibility violation/);
      expect(err.message).to.match(/CRITICAL|SERIOUS/);
      // The disclaimer travels with every verdict, including this one.
      expect(err.message).to.match(/subset of WCAG success criteria/);
      return false;
    });
    cy.checkA11y({ baseline: false });
  });

  it('passes once the violations are recorded, and catches a new one', () => {
    cy.task('skiplink:reset-baseline', BASELINE, { log: false });

    // Record, then the same page passes.
    cy.checkA11y({ baseline: BASELINE, updateBaseline: true });
    cy.checkA11y({ baseline: BASELINE });

    // Add a genuinely new failure on a sibling of an accepted one.
    cy.document().then((doc) => {
      const p = doc.createElement('p');
      p.className = 'hero__caption';
      p.style.color = '#9d9d9d';
      p.style.background = '#fff';
      p.style.fontSize = '14px';
      p.textContent = 'Added after the baseline was recorded';
      doc.body.append(p);
    });

    cy.on('fail', (err) => {
      expect(err.message).to.match(/hero__caption/);
      return false;
    });
    cy.checkA11y({ baseline: BASELINE });
  });

  it('yields the result so you can assert on it', () => {
    cy.checkA11y({ baseline: false, failOn: 'never' }).then((result) => {
      expect(result.summary).to.have.keys(['critical', 'serious', 'moderate', 'minor']);
      expect(result.violations.length).to.be.greaterThan(0);
    });
  });
});
