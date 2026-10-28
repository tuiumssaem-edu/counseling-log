/**
 * 학급 상담 관찰 기록장 - Google Apps Script 서버 코드
 *
 * 사용 방법 (자세한 안내는 앱의 ⚙ 설정 > 시트 연결 안내에 있습니다)
 *   1. 빈 Google 스프레드시트를 만들고 [확장 프로그램 → Apps Script]를 엽니다.
 *   2. 이 코드를 Code.gs에 전부 붙여 넣고 저장합니다.
 *   3. [배포 → 새 배포 → 웹 앱]  실행: 나 / 액세스 권한: 모든 사용자 → 배포
 *   4. 받은 웹 앱 주소(/exec)를 앱의 시트 연결 화면에 넣습니다.
 *
 * 보안
 *   - 학생 이름은 앱(브라우저)에서 비밀번호로 암호화한 뒤 보내므로 시트에는 암호문만 저장됩니다.
 *   - 비밀번호는 서버에 보내지 않습니다. 비밀번호에서 만든 '접속 확인 값'의 해시만 저장해
 *     비밀번호를 모르는 사람은 기록을 읽거나 쓸 수 없습니다.
 *   - 학생별 시트 이름은 실명이 아닌 코드(학생_S7K2M9 등)로 만듭니다.
 *
 * 시트 구조 (처음 사용할 때 자동으로 만들어집니다)
 *   학생목록      : 학생ID | 시트이름 | 이름(암호화) | 학년 | 반 | 번호 | 상태 | 등록일시 | 수정일시
 *   학생_<학생ID> : 기록ID | 저장일시 | 상담일시 | 대상 | 방법 | 상담시간 | 상담내용 | 비고
 */

var APP_ID = 'counseling-log';
var APP_VERSION = '1.0.0';

var STUDENT_SHEET = '학생목록';
var STUDENT_HEADERS = ['학생ID', '시트이름', '이름(암호화)', '학년', '반', '번호', '상태', '등록일시', '수정일시'];
var RECORD_HEADERS = ['기록ID', '저장일시', '상담일시', '대상', '방법', '상담시간', '상담내용', '비고'];
var RECORD_SHEET_PREFIX = '학생_';

var STATUS_ACTIVE = '활성';
var STATUS_HIDDEN = '숨김';

var PROP_SALT = 'CL_SALT';
var PROP_AUTH = 'CL_AUTH_HASH';
var PROP_SETUP_AT = 'CL_SETUP_AT';

var MAX_FAILS = 10;          // 비밀번호가 이만큼 틀리면
var FAIL_WINDOW_SEC = 600;   // 이 시간(초) 동안 잠급니다.
var MAX_TEXT = 20000;        // 한 칸에 저장할 최대 글자 수

/* =========================================================
 * 1. 진입점
 * ========================================================= */

/** 주소로 직접 열었을 때: 연결 확인용 정보만 돌려줍니다. (학생 정보는 없음) */
function doGet() {
  return json_({ ok: true, app: APP_ID, version: APP_VERSION, message: '학급 상담 관찰 기록장 서버가 작동 중입니다.' });
}

/** 앱이 보내는 모든 요청을 처리합니다. */
function doPost(e) {
  var req;
  try {
    req = JSON.parse((e && e.postData && e.postData.contents) || '{}');
  } catch (err) {
    return json_({ ok: false, code: 'BAD_REQUEST', error: '요청 형식이 올바르지 않습니다.' });
  }

  try {
    var action = String(req.action || '');

    // 인증 없이 쓸 수 있는 요청
    if (action === 'status') return json_(status_());
    if (action === 'init') return json_(withLock_(function () { return init_(req); }));

    // 나머지는 비밀번호(접속 확인 값)가 맞아야 합니다.
    var auth = checkAuth_(req.auth);
    if (!auth.ok) return json_(auth);

    var handlers = {
      checkSetup: checkSetup_,
      listStudents: listStudents_,
      addStudent: addStudent_,
      updateStudent: updateStudent_,
      setStudentStatus: setStudentStatus_,
      deleteStudent: deleteStudent_,
      saveRecord: saveRecord_,
      getRecords: getRecords_
    };
    var fn = handlers[action];
    if (!fn) return json_({ ok: false, code: 'UNKNOWN_ACTION', error: '알 수 없는 요청입니다: ' + action });

    var readOnly = action === 'checkSetup' || action === 'listStudents' || action === 'getRecords';
    var result = readOnly ? fn(req) : withLock_(function () { return fn(req); });
    return json_(result);
  } catch (err) {
    return json_({ ok: false, code: 'SERVER_ERROR', error: String(err && err.message ? err.message : err) });
  }
}

/* =========================================================
 * 2. 처음 설정과 인증
 * ========================================================= */

function status_() {
  var props = PropertiesService.getScriptProperties();
  var salt = props.getProperty(PROP_SALT);
  return {
    ok: true,
    app: APP_ID,
    version: APP_VERSION,
    initialized: !!(salt && props.getProperty(PROP_AUTH)),
    salt: salt || null
  };
}

/** 처음 한 번: 비밀번호에서 만든 값의 해시와 salt를 저장합니다. 이미 설정되어 있으면 거절합니다. */
function init_(req) {
  var props = PropertiesService.getScriptProperties();
  if (props.getProperty(PROP_SALT) && props.getProperty(PROP_AUTH)) {
    return { ok: false, code: 'ALREADY_INITIALIZED', error: '이미 비밀번호가 설정된 서버입니다.' };
  }
  var salt = String(req.salt || '');
  var auth = String(req.auth || '');
  if (!/^[A-Za-z0-9+/=]{16,100}$/.test(salt) || !/^[0-9a-f]{64}$/.test(auth)) {
    return { ok: false, code: 'BAD_REQUEST', error: '설정 값이 올바르지 않습니다.' };
  }
  props.setProperty(PROP_SALT, salt);
  props.setProperty(PROP_AUTH, sha256Hex_(auth));
  props.setProperty(PROP_SETUP_AT, new Date().toISOString());
  ensureStudentSheet_();
  return { ok: true };
}

function checkAuth_(auth) {
  var props = PropertiesService.getScriptProperties();
  var stored = props.getProperty(PROP_AUTH);
  if (!stored) return { ok: false, code: 'NOT_INITIALIZED', error: '아직 비밀번호가 설정되지 않았습니다.' };

  var cache = CacheService.getScriptCache();
  var fails = Number(cache.get('cl_fails') || 0);
  if (fails >= MAX_FAILS) {
    return { ok: false, code: 'LOCKED', error: '비밀번호가 여러 번 틀려 10분 동안 잠겼습니다. 잠시 후 다시 시도해 주세요.' };
  }
  if (typeof auth !== 'string' || !/^[0-9a-f]{64}$/.test(auth) || sha256Hex_(auth) !== stored) {
    cache.put('cl_fails', String(fails + 1), FAIL_WINDOW_SEC);
    return { ok: false, code: 'AUTH_FAILED', error: '비밀번호가 맞지 않습니다.' };
  }
  if (fails) cache.remove('cl_fails');
  return { ok: true };
}

/* =========================================================
 * 3. 학생 관리
 * ========================================================= */

function listStudents_() {
  var sheet = ensureStudentSheet_();
  return { ok: true, students: readStudents_(sheet).map(function (s) { return s.data; }) };
}

function addStudent_(req) {
  var sheet = ensureStudentSheet_();
  var encName = cleanCipher_(req.encName);
  if (!encName) return { ok: false, code: 'BAD_REQUEST', error: '학생 이름 정보가 올바르지 않습니다.' };

  var id = newId_('S', 6);
  var existing = readStudents_(sheet).map(function (s) { return s.data.id; });
  while (existing.indexOf(id) !== -1) id = newId_('S', 6);

  var sheetName = RECORD_SHEET_PREFIX + id;
  var now = nowText_();
  ensureRecordSheet_(sheetName);
  sheet.appendRow([id, sheetName, encName, cleanSmall_(req.grade), cleanSmall_(req.classNum), cleanSmall_(req.number), STATUS_ACTIVE, now, now]);
  return { ok: true, student: { id: id, sheetName: sheetName, encName: encName, grade: cleanSmall_(req.grade), classNum: cleanSmall_(req.classNum), number: cleanSmall_(req.number), status: STATUS_ACTIVE, records: 0 } };
}

function updateStudent_(req) {
  var sheet = ensureStudentSheet_();
  var found = findStudent_(sheet, req.id);
  if (!found) return { ok: false, code: 'NOT_FOUND', error: '학생을 찾을 수 없습니다. 새로고침 후 다시 시도해 주세요.' };
  var encName = cleanCipher_(req.encName);
  if (!encName) return { ok: false, code: 'BAD_REQUEST', error: '학생 이름 정보가 올바르지 않습니다.' };
  sheet.getRange(found.row, 3, 1, 4).setValues([[encName, cleanSmall_(req.grade), cleanSmall_(req.classNum), cleanSmall_(req.number)]]);
  sheet.getRange(found.row, 9).setValue(nowText_());
  return { ok: true };
}

function setStudentStatus_(req) {
  var sheet = ensureStudentSheet_();
  var found = findStudent_(sheet, req.id);
  if (!found) return { ok: false, code: 'NOT_FOUND', error: '학생을 찾을 수 없습니다.' };
  var status = req.status === STATUS_HIDDEN ? STATUS_HIDDEN : STATUS_ACTIVE;
  sheet.getRange(found.row, 7).setValue(status);
  sheet.getRange(found.row, 9).setValue(nowText_());
  return { ok: true };
}

/** 학생과 그 학생의 기록 시트를 완전히 삭제합니다. */
function deleteStudent_(req) {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = ensureStudentSheet_();
  var found = findStudent_(sheet, req.id);
  if (!found) return { ok: false, code: 'NOT_FOUND', error: '학생을 찾을 수 없습니다.' };
  var recordSheet = ss.getSheetByName(found.data.sheetName);
  if (recordSheet) ss.deleteSheet(recordSheet);
  sheet.deleteRow(found.row);
  return { ok: true };
}

/* =========================================================
 * 4. 상담 기록
 * ========================================================= */

/** 상담 기록 한 건을 학생 시트에 한 줄로 저장합니다. 같은 기록ID는 두 번 저장하지 않습니다. */
function saveRecord_(req) {
  var sheet = ensureStudentSheet_();
  var found = findStudent_(sheet, req.studentId);
  if (!found) return { ok: false, code: 'NOT_FOUND', error: '학생을 찾을 수 없습니다. 학생 목록을 새로고침해 주세요.' };

  var r = req.record || {};
  var recordId = /^[A-Za-z0-9_-]{8,64}$/.test(String(r.id || '')) ? String(r.id) : newId_('R', 12);
  var content = cleanText_(r.content);
  if (!content) return { ok: false, code: 'BAD_REQUEST', error: '상담 내용을 입력해 주세요.' };

  var recordSheet = ensureRecordSheet_(found.data.sheetName);
  var last = recordSheet.getLastRow();
  if (last > 1) {
    var ids = recordSheet.getRange(2, 1, last - 1, 1).getValues();
    for (var i = 0; i < ids.length; i++) {
      if (String(ids[i][0]) === recordId) return { ok: true, duplicate: true, recordId: recordId };
    }
  }

  var row = [recordId, nowText_(), cleanSmall_(r.date, 40), cleanSmall_(r.target, 20), cleanSmall_(r.method, 20), cleanSmall_(r.time, 60), content, cleanText_(r.note)];
  // 모든 칸을 '글자' 형식으로 정한 뒤 넣어 날짜·숫자·수식 자동 변환을 막습니다.
  var target = recordSheet.getRange(recordSheet.getLastRow() + 1, 1, 1, row.length);
  target.setNumberFormat('@');
  target.setValues([row]);
  return { ok: true, recordId: recordId };
}

function getRecords_(req) {
  var sheet = ensureStudentSheet_();
  var found = findStudent_(sheet, req.studentId);
  if (!found) return { ok: false, code: 'NOT_FOUND', error: '학생을 찾을 수 없습니다.' };
  var recordSheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(found.data.sheetName);
  if (!recordSheet || recordSheet.getLastRow() <= 1) return { ok: true, records: [] };

  var values = recordSheet.getRange(2, 1, recordSheet.getLastRow() - 1, RECORD_HEADERS.length).getValues();
  var records = values.filter(function (v) { return String(v[0]) !== ''; }).map(function (v) {
    return { id: text_(v[0]), savedAt: text_(v[1]), date: text_(v[2]), target: text_(v[3]), method: text_(v[4]), time: text_(v[5]), content: text_(v[6]), note: text_(v[7]) };
  }).reverse();
  var limit = Math.max(1, Math.min(Number(req.limit) || 50, 500));
  return { ok: true, total: records.length, records: records.slice(0, limit) };
}

/* =========================================================
 * 5. 연결 점검
 * ========================================================= */

function checkSetup_() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = ensureStudentSheet_();
  var students = readStudents_(sheet);
  var missingSheets = 0;
  var badHeaders = 0;
  var totalRecords = 0;
  students.forEach(function (s) {
    var rs = ss.getSheetByName(s.data.sheetName);
    if (!rs) { missingSheets++; return; }
    if (!headersMatch_(rs, RECORD_HEADERS)) badHeaders++;
    totalRecords += Math.max(rs.getLastRow() - 1, 0);
  });
  return {
    ok: true,
    spreadsheetName: ss.getName(),
    spreadsheetUrl: ss.getUrl(),
    studentHeadersOk: headersMatch_(sheet, STUDENT_HEADERS),
    studentCount: students.filter(function (s) { return s.data.status !== STATUS_HIDDEN; }).length,
    hiddenCount: students.filter(function (s) { return s.data.status === STATUS_HIDDEN; }).length,
    missingSheets: missingSheets,
    badHeaders: badHeaders,
    totalRecords: totalRecords,
    version: APP_VERSION
  };
}

/* =========================================================
 * 6. 내부 도우미
 * ========================================================= */

function json_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}

function withLock_(fn) {
  var lock = LockService.getScriptLock();
  if (!lock.tryLock(20000)) {
    return { ok: false, code: 'BUSY', error: '다른 저장 작업이 진행 중입니다. 잠시 후 다시 시도해 주세요.' };
  }
  try {
    return fn();
  } finally {
    lock.releaseLock();
  }
}

/** 학생목록 시트를 만들고 1행 제목을 맞춥니다. */
function ensureStudentSheet_() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = ss.getSheetByName(STUDENT_SHEET);
  if (!sheet) sheet = ss.insertSheet(STUDENT_SHEET, 0);
  writeHeaders_(sheet, STUDENT_HEADERS, '#E8E3FB');
  return sheet;
}

/** 학생 기록 시트를 만들고 1행 제목을 맞춥니다. 모든 학생 시트는 같은 제목을 씁니다. */
function ensureRecordSheet_(name) {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = ss.getSheetByName(name);
  if (!sheet) sheet = ss.insertSheet(name);
  writeHeaders_(sheet, RECORD_HEADERS, '#E6F4EA');
  return sheet;
}

function writeHeaders_(sheet, headers, color) {
  if (headersMatch_(sheet, headers)) return;
  if (sheet.getLastRow() === 0) {
    sheet.appendRow(headers);
  } else {
    sheet.getRange(1, 1, 1, headers.length).setValues([headers]);
  }
  sheet.getRange(1, 1, 1, headers.length).setFontWeight('bold').setBackground(color);
  sheet.setFrozenRows(1);
}

function headersMatch_(sheet, headers) {
  if (sheet.getLastRow() === 0 || sheet.getLastColumn() < headers.length) return false;
  var row = sheet.getRange(1, 1, 1, headers.length).getValues()[0];
  for (var i = 0; i < headers.length; i++) {
    if (String(row[i]).trim() !== headers[i]) return false;
  }
  return true;
}

function readStudents_(sheet) {
  var last = sheet.getLastRow();
  if (last <= 1) return [];
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var values = sheet.getRange(2, 1, last - 1, STUDENT_HEADERS.length).getValues();
  var list = [];
  values.forEach(function (v, i) {
    if (String(v[0]) === '') return;
    var rs = ss.getSheetByName(text_(v[1]));
    list.push({
      row: i + 2,
      data: {
        id: text_(v[0]),
        sheetName: text_(v[1]),
        encName: text_(v[2]),
        grade: text_(v[3]),
        classNum: text_(v[4]),
        number: text_(v[5]),
        status: text_(v[6]) || STATUS_ACTIVE,
        records: rs ? Math.max(rs.getLastRow() - 1, 0) : 0
      }
    });
  });
  return list;
}

function findStudent_(sheet, id) {
  id = String(id || '');
  if (!id) return null;
  var list = readStudents_(sheet);
  for (var i = 0; i < list.length; i++) {
    if (list[i].data.id === id) return list[i];
  }
  return null;
}

function text_(v) {
  if (v === null || v === undefined) return '';
  if (Object.prototype.toString.call(v) === '[object Date]') {
    return Utilities.formatDate(v, Session.getScriptTimeZone(), 'yyyy-MM-dd HH:mm');
  }
  return String(v);
}

function nowText_() {
  return Utilities.formatDate(new Date(), Session.getScriptTimeZone(), 'yyyy-MM-dd HH:mm:ss');
}

function cleanCipher_(v) {
  v = String(v || '');
  return /^v1\.[A-Za-z0-9+/=]+\.[A-Za-z0-9+/=]+$/.test(v) && v.length < 2000 ? v : '';
}

function cleanSmall_(v, max) {
  return String(v === null || v === undefined ? '' : v).trim().slice(0, max || 10);
}

function cleanText_(v) {
  return String(v === null || v === undefined ? '' : v).trim().slice(0, MAX_TEXT);
}

function newId_(prefix, len) {
  var chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  var out = '';
  var uuid = Utilities.getUuid().replace(/-/g, '');
  for (var i = 0; i < len; i++) {
    out += chars.charAt(parseInt(uuid.substr(i * 2, 2), 16) % chars.length);
  }
  return prefix + out;
}

function sha256Hex_(s) {
  var bytes = Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, s, Utilities.Charset.UTF_8);
  return bytes.map(function (b) { return ('0' + (b & 0xff).toString(16)).slice(-2); }).join('');
}
