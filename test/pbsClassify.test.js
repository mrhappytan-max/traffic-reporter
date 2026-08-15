import { test } from 'node:test';
import assert from 'node:assert/strict';
import { classifyPbsEvent } from '../src/pbs/classify.js';

test('accident: roadtype=事故 or comment mentions 事故/擦撞/追撞', () => {
  assert.equal(classifyPbsEvent({ roadtype: '事故', comment: '' }).type, 'accident');
  assert.equal(classifyPbsEvent({ comment: '西行在8.1公里處發生交通事故' }).type, 'accident');
  assert.equal(classifyPbsEvent({ comment: '內線車道擦撞事件' }).type, 'accident');
  assert.equal(classifyPbsEvent({ comment: '追撞事故一起' }).type, 'accident');
});

test('obstruction (散落物/輪胎皮/保險桿/布鉤繩/落物/異物) maps to type "other" with pbsCategory "obstruction"', () => {
  for (const comment of ['路面散落物', '輪胎皮掉落', '保險桿掉落路面', '布鉤繩纏繞', '不明落物', '路面異物']) {
    const result = classifyPbsEvent({ comment });
    assert.equal(result.type, 'other', comment);
    assert.equal(result.pbsCategory, 'obstruction', comment);
  }
});

test('breakdown (故障車/拋錨) maps to type "other" with pbsCategory "breakdown"', () => {
  assert.deepEqual(classifyPbsEvent({ comment: '內線故障車' }), { type: 'other', pbsCategory: 'breakdown' });
  assert.deepEqual(classifyPbsEvent({ comment: '車輛拋錨' }), { type: 'other', pbsCategory: 'breakdown' });
});

test('construction -> type "construction"', () => {
  assert.equal(classifyPbsEvent({ comment: '路面施工作業中' }).type, 'construction');
});

test('control (交通管制/匝道儀控/封閉) -> type "control"', () => {
  assert.equal(classifyPbsEvent({ comment: '交通管制中' }).type, 'control');
  assert.equal(classifyPbsEvent({ comment: '匝道儀控實施中' }).type, 'control');
  assert.equal(classifyPbsEvent({ comment: '車道封閉' }).type, 'control');
});

test('congestion (壅塞/回堵) -> type "congestion"', () => {
  assert.equal(classifyPbsEvent({ comment: '車多回堵4公里' }).type, 'congestion');
  assert.equal(classifyPbsEvent({ comment: '嚴重壅塞' }).type, 'congestion');
});

test('dangerous driving (危險駕駛/車輛蛇行/路肩逆向/大型車異常) maps to type "other"', () => {
  for (const comment of ['發現危險駕駛', '車輛蛇行', '路肩逆向行駛', '大型車異常']) {
    const result = classifyPbsEvent({ comment });
    assert.equal(result.type, 'other', comment);
    assert.equal(result.pbsCategory, 'dangerous-driving', comment);
  }
});

test('unrelated/generic text falls back to type "other", pbsCategory "other"', () => {
  assert.deepEqual(classifyPbsEvent({ comment: '今日天氣晴朗' }), { type: 'other', pbsCategory: 'other' });
  assert.deepEqual(classifyPbsEvent({}), { type: 'other', pbsCategory: 'other' });
});
