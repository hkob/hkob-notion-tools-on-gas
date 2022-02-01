// Notion に payload を send する
function sendNotion(url, payload, method) {
  let options = {
    "method": method,
    "headers": {
      "Content-type": "application/json",
      "Authorization": "Bearer " + myNotionToken(),
      "Notion-Version": "2021-08-16",
    },
    "payload": payload ? JSON.stringify(payload) : null
  };
  // デバッグ時にはコメントを外す
  //Logger.log(options)
  Utilities.sleep(400);
  return JSON.parse(UrlFetchApp.fetch(url, options))
}

function createPage(payload) {
  return sendNotion("https://api.notion.com/v1/pages", payload, "POST")
}

// title, date_hash と project_id から create payload を作成 (project_id は省略可能)
function createPayload(title, date_hash, project_id = null) {
  let relation = project_id ? [{ "id": project_id }] : []
  return {
    "parent": {
      "database_id": databaseId()
    },
    "properties": {
      "タスク名": {
        "title": [
          {
            "text": {
              "content": title
            }
          }
        ]
      },
      "日付": {
        "type": "date",
        "date": date_hash
      },
      "Project": {
        "type": "relation",
        "relation": relation
      }
    }
  }
}

// title と date_hash から update payload を作成
function updatePayload(title, date_hash) {
  return {
    "properties": {
      "日付": {
        "date": date_hash
      },
      "タスク名": {
        "title": [
          {
            "text": {
              "content": title
            }
          }
        ]
      }
    }
  }
}

// カレンダーイベントが変更されたら呼ばれるメソッド
function doCalendarPost(event) {
  let calendarId = event.calendarId // カレンダーIDのの取得
  let token = getSyncToken(calendarId) // 前回実行時に取得したカレンダーTokenの取得
  let events = Calendar.Events.list(calendarId, { 'syncToken': token }) // Token から後のカレンダーを取得
  let filteredItems = events.items.filter(e => { return e.status == "confirmed" }) // ステータスを見て登録、もしくは更新の予定のみにフィルタリング
  saveSyncToken(events.nextSyncToken) // 今回のTokenを保存する(次回のScript実行時に利用)
  filteredItems.forEach(e => {
    let descriptions = (e.description || "").split("\n")
    console.log(descriptions)
    let dlen = descriptions.length
    let exist = false
    let id = '-'
    if (dlen > 0) { // 行が存在する場合
      last_line = descriptions[dlen - 1] // 最後の行を取得
      let ids = last_line.match(/^id:(.*)$/) // id を取得
      if (ids != null && ids[1].length > 31) { // 取得できた場合
        id = ids[1]; // 取得した id
        exist = true
      }
    }
    let date_hash = eventToHash(e) // イベント日付を取得
    if (date_hash) { // イベントに日付がある場合だけ実施
      if (exist) { // 存在した場合は update
        let payload = updatePayload(e.summary, date_hash)
        updatePage(id, payload)
      } else {
        let payload = createPayload(e.summary, date_hash)
        let ans = createPage(payload)
        id = ans["id"]
        descriptions.push("id:" + id)
        e.description = descriptions.join("\n")
        Calendar.Events.patch(e, calendarId, e.id)
      }
    }
  })
}

// 前回保存したカレンダーのSyncTokenを取り出す、前回保存分が無い場合は今回のSyncTokenを利用する
function getSyncToken(calendarId) {
  var token = PropertiesService.getScriptProperties().getProperty('SYNC_TOKEN')
  if (token) {
    return token
  }
  let events = Calendar.Events.list(calendarId, { 'timeMin': (new Date()).toISOString() })
  return events.nextSyncToken
}

// カレンダーイベントから日付の hash  を作成 (削除時にも呼ばれるので、イベントに日付が設定されていなければ null を返却)
function eventToHash(e) {
  let hash = null
  if ('dateTime' in e.start) {
    hash = {
      "start": e.start.dateTime.replace("T", " "),
      "end": e.end.dateTime.replace("T", " ")
    }
  }
  if ('date' in e.start) {
    hash = {
      "start": e.start.date
    }
  }
  return hash
}

// SyncTokenをプロパティに保存する
function saveSyncToken(token) {
  PropertiesService.getScriptProperties().setProperty('SYNC_TOKEN', token)
}

function weekToStr(date) {
  let w = Utilities.formatDate(date, "JST", "u")
  return ["日", "月", "火", "水", "木", "金", "土", "日"][w]
}

// date の日付がテーブルの行ごとに当てはまるか確認し、当てはまれば Notion にポスト
// デバッグテスト用に date を変えながらテストしていた
function selectEvents(date) {
  var sheet = SpreadsheetApp.getActiveSheet()
  var lastrow = sheet.getLastRow()
  for (let row = 1; row < lastrow; row++) {
    let lines = sheet.getRange("A" + (row + 1) + ":H" + (row + 1)).getValues()[0]
    if (isValidEvent(lines, date)) {
      let title = lines[0] + ((lines[1] && lines[1].toFixed() == 1) ? Utilities.formatDate(date, "JST", " M/d (" + weekToStr(date) + ")") : "")
      let date_hash = { "start": Utilities.formatDate(date, "JST", "yyyy-MM-dd") }
      let project_id = getProjectId(lines[7])
      createPage(createPayload(title, date_hash, project_id))
      sheet.getRange("I" + (row + 1)).setValue(date)
    }
  }
}

// lines の繰り返しイベント情報を元に date が当てはまる時に true を返す
// and 条件なので、一つでも条件に満足しない時に false を返す (最後まで引っ掛からなければ true)
function isValidEvent(lines, date) {
  let aDay = 86400000
  // 基準日とインターバルが設定されている時、インターバルの倍数の日以外なら false
  let baseDate = lines[2]
  let interval = lines[3] && lines[3].toFixed()
  if (baseDate && interval > 0) {
    let diff = ((date - baseDate) / aDay).toFixed()
    if (diff % interval != 0) {
      return false
    }
  }
  // 月が設定されている時、月が一致しなければ false
  let month = lines[4] && lines[4].toFixed()
  if (month > 0 && month != date.getMonth()) {
    return false
  }
  let day = lines[6] && lines[6].toFixed()
  // 日(day)が設定されていて day > 0 なら (day - 1)日前が 1 日でなければ false
  if (day > 0 && new Date(date.getYear(), date.getMonth(), date.getDate() - (day - 1)).getDate().toFixed() != 1) {
    return false
  }
  // 日(day)が設定されていて day < 0 なら |day|日後が 1 日でなければ false
  if (day < 0 && new Date(date.getYear(), date.getMonth(), date.getDate() - day).getDate().toFixed() != 1) {
    return false
  }
  // 週(week)が設定されていて、(date.day - 1) / 7 == week - 1 でなければ false
  let week = lines[5] && lines[5].toFixed()
  if (week > 0 && ((date.getDate() - 1) / 7).toFixed() != (week - 1).toFixed()) {
    return false
  }
  return true
}

// これまで通り、毎朝呼ばれる関数
function doEverydayPost() {
  let today = new Date()
  selectEvents(today)
  setMonthlyPageRelationToReflectionPage(today)
  let yesterday = new Date()
  yesterday.setDate(today.getDate() - 1)
  updateStatistics(yesterday)
  updateDelayedTask()
}

// MY_NOTION_TOKEN と DATABASE_ID をプロパティに登録する(1回だけ使い、終わったらIDを消す)
function storeTokenAndIds() {
  const scriptProperties = PropertiesService.getScriptProperties()
  scriptProperties.setProperties({
    "MY_NOTION_TOKEN": "ここに「Notion Token」を記述",
    "DATABASE_ID": "ここに「データベースID」を記述",
    "PROJECT_ID": "ここに「プロジェクトID」を記述",
    "MONTHLY_ID": "ここに「月報ID」を記述"
  })
  // 登録できたことを確認
  console.log("myNotionToken = " + myNotionToken())
  console.log("databaseId = " + databaseId())
  console.log("projectId = " + projectId())
  console.log("monthlyId = " + monthlyId())
}

// MY_NOTION_TOKEN を取得
function myNotionToken() {
  return PropertiesService.getScriptProperties().getProperty("MY_NOTION_TOKEN")
}

// DATABASE_ID を取得
function databaseId() {
  return PropertiesService.getScriptProperties().getProperty("DATABASE_ID")
}

// PROJECT_ID を取得
function projectId() {
  return PropertiesService.getScriptProperties().getProperty("PROJECT_ID")
}

// MONTHLY_ID を取得
function monthlyId() {
  return PropertiesService.getScriptProperties().getProperty("MONTHLY_ID")
}

// Notion のデータベースを query するメソッド (payload にフィルタや並び順を設定しておく)
function getPages(payload, id = null) {
  let connectId = id || databaseId()
  let url = "https://api.notion.com/v1/databases/" + connectId + "/query" // API URL
  return sendNotion(url, payload, "POST")
}

// Notion のブロックの子供一覧を query するメソッド (payload にフィルタや並び順を設定しておく)
function getBlockChildren(blockId, pageSize = 50) {
  let url = "https://api.notion.com/v1/blocks/" + blockId + "/children?page_size=" + pageSize // API URL
  return sendNotion(url, null, "GET")
}

// 未終了のタスクを一括で取得する
function getUnfinished() {
  let payload = {
    "filter": {
      "and": [
        {
          "property": "Done",
          "checkbox": {
            "equals": false
          }
        },
        {
          "property": "日付",
          "date": {
            "before": new Date()
          }
        }
      ]
    },
    "sorts": [
      {
        "property": "日付",
        "direction": "ascending"
      }
    ]
  }
  return getPages(payload)
}

function getMonthlyId(date) {
  let name = Utilities.formatDate(date, "JST", "YYYY - MM")
  let payload = {
    "filter": {
      "property": "Months",
      "text": {
        "equals": name,
      },
    }
  }
  var ans = null;
  let page = getPages(payload, monthlyId())["results"][0]
  if (page) {
    ans = page["id"]
  } else {
    let newPayload = {
      "parent": {
        "database_id": monthlyId(),
      },
      "properties": {
        "Months": {
          "title": [
            {
              "text": {
                "content": name
              }
            }
          ]
        }
      }
    }
    ans = createPage(newPayload)["id"]
  }
  return ans
}

function test() {
  var date = new Date("2022/1/1")
  Logger.log(date.getMonth())
  while (date.getMonth() == 0) {
    Logger.log(date)
    setMonthlyPageRelationToReflectionPage(date)
    date.setDate(date.getDate() + 1)
  }
}

function setMonthlyPageRelationToReflectionPage(date) {
  let reflectionPageId = getReflectionPageId(date)
  let payload = {
    "properties": {
      "月報": {
        "type": "relation",
        "relation": [
          {
            "id": getMonthlyId(date)
          }
        ]
      }
    }
  }
  return updatePage(reflectionPageId, payload)
}

function getReflectionPageId(date) {
  let payload = {
    "filter": {
      "and": [
        {
          "property": "タスク名",
          "text": {
            "starts_with": "雑務・振り返り",
          },
        },
        {
          "property": "日付",
          "date": {
            "equals": Utilities.formatDate(date, "JST", "YYYY-MM-dd")
          },
        },
      ]
    }
  }
  return getPages(payload, databaseId())["results"][0]["id"]
}

// title と date_hash から update payload を作成
function updatePayload(title, date_hash) {
  return {
    "properties": {
      "日付": {
        "date": date_hash
      },
      "タスク名": {
        "title": [
          {
            "text": {
              "content": title
            }
          }
        ]
      }
    }
  }
}

function getProjectId(name) {
  var ans = null
  if (name != "") {
    let page = getProjectByName(name)["results"][0]
    ans = page ? page["id"] : null
  }
  return ans
}

// 名前からプロジェクトを取得する
function getProjectByName(name) {
  let payload = {
    "filter": {
      "property": "name",
      "text": {
        "equals": name,
      },
    }
  }
  return getPages(payload, projectId())
}

function updatePage(pageId, payload) {
  let url = "https://api.notion.com/v1/pages/" + pageId // API URL
  sendNotion(url, payload, "PATCH")
}

function updateDelayedTask() {
  // unfinished
  let unfinished = getUnfinished()["results"];
  unfinished.forEach(t => {
    let pageId = t["id"]
    Logger.log(t)
    let delayedText = t["properties"]["遅延"]["rich_text"][0]
    let plainText = delayedText ? delayedText.plain_text : ""
    let payload = {
      "properties": {
        "遅延": {
          "rich_text": [
            {
              "text": {
                "content": plainText + "●"
              }
            }
          ]
        }
      }
    }
    updatePage(pageId, payload)
  })
}

function test2() {
  var date = new Date("2022/1/1")
  Logger.log(date.getMonth())
  while (date.getMonth() == 0) {
    Logger.log(date)
    updateStatistics(date)
    date.setDate(date.getDate() + 1)
  }
  //Logger.log(setMonthlyPageRelationToReflectionPage(new Date()))
}

function getTheNumberOfPomos(date) {
  let payload = {
    "filter": {
      "and": [
        {
          "property": "🍅",
          "multi_select": {
            "is_not_empty": true,
          },
        },
        {
          "property": "日付",
          "date": {
            "equals": Utilities.formatDate(date, "JST", "YYYY-MM-dd")
          },
        },
      ]
    }
  }
  return getPages(payload, databaseId())["results"].reduce((sum, p) => sum + p["properties"]["🍅"]["multi_select"].length, 0)
}

function updateStatistics(date) {
  let reflectionPageId = getReflectionPageId(date)
  let isRecorded = getBlockChildren(reflectionPageId, 1)["results"].length == 1
  let numOfPomos = getTheNumberOfPomos(date)
  let payload = {
    "properties": {
      "記録あり": {
        "checkbox": isRecorded
      },
      "実行🍅数": {
        "number": numOfPomos
      }
    }
  }
  updatePage(reflectionPageId, payload)
}