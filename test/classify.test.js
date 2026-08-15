import { test } from 'node:test';
import assert from 'node:assert/strict';
import { classifyByKeyword, classifyAlertText } from '../src/tdx/classify.js';

test('classifyByKeyword maps Chinese keywords to the right bucket', () => {
  assert.equal(classifyByKeyword('國道1號發生車禍事故'), 'accident');
  assert.equal(classifyByKeyword('路面施工作業中'), 'construction');
  assert.equal(classifyByKeyword('前方道路封閉請改道'), 'closure');
  assert.equal(classifyByKeyword('交通管制中，請配合疏導'), 'control');
  assert.equal(classifyByKeyword('路段車多回堵'), 'congestion');
  assert.equal(classifyByKeyword('今日晴時多雲'), 'other');
  assert.equal(classifyByKeyword(''), 'other');
  assert.equal(classifyByKeyword(null), 'other');
});

test('classifyAlertText defaults to "alert" instead of "other"', () => {
  assert.equal(classifyAlertText('路線臨時繞道行駛'), 'alert');
  assert.equal(classifyAlertText('因道路施工繞道'), 'construction');
});
