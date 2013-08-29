var ranges = require('string-range')

module.exports = function (db) {

  if(db.hooks) {
    return     
  }

  var posthooks = []
  var prehooks  = []

  function asyncEach(arr, iterator, callback) {
    var pending = arr.length
    if(!pending) return callback(null)
    arr.forEach(function (item, i) {
      iterator.call(null, item, i, function (err) {
        if(err) {
          pending = 0
          return callback(err)
        }
        if(!--pending) callback(null)
      })
    })
  }

  function getPrefix (p) {
    return p && (
        'string' ===   typeof p        ? p
      : 'string' ===   typeof p.prefix ? p.prefix
      : 'function' === typeof p.prefix ? p.prefix()
      :                                  ''
      )
  }

  function getKeyEncoding (db) {
    if(db && db._getKeyEncoding)
      return db._getKeyEncoding(db)
  }

  function getValueEncoding (db) {
    if(db && db._getValueEncoding)
      return db._getValueEncoding(db)
  }

  function remover (array, item) {
    return function () {
      var i = array.indexOf(item)
      if(!~i) return false        
      array.splice(i, 1)
      return true
    }
  }

  db.hooks = {
    post: function (prefix, hook) {
      if(!hook) hook = prefix, prefix = ''
      var h = {test: ranges.checker(prefix), hook: hook}
      posthooks.push(h)
      return remover(posthooks, h)
    },
    pre: function (prefix, hook) {
      if(!hook) hook = prefix, prefix = ''
      var h = {test: ranges.checker(prefix), hook: hook}
      prehooks.push(h)
      return remover(prehooks, h)
    },
    posthooks: posthooks,
    prehooks: prehooks
  }

  //POST HOOKS

  function each (e) {
    if(e && e.type) {
      posthooks.forEach(function (h) {
        if(h.test(e.key)) h.hook(e)
      })
    }
  }

  db.on('put', function (key, val) {
    each({type: 'put', key: key, value: val})
  })
  db.on('del', function (key, val) {
    each({type: 'del', key: key, value: val})
  })
  db.on('batch', function onBatch (ary) {
    ary.forEach(each)
  })

  //PRE HOOKS

  var put = db.put
  var del = db.del
  var batch = db.batch

  function callHooks (isBatch, b, opts, cb) {
    asyncEach(b, function hook(e, i, doneHooks) {
      asyncEach(prehooks, function (h, j, doneHook) {
        if(!h.test(String(e.key))) return doneHook(null)

        //optimize this?
        //maybe faster to not create a new object each time?
        //have one object and expose scope to it?
        var context = {
          add: function (ch, db, done) {
            if(typeof ch === 'undefined')
              return done(null)
            if(ch === false) {
              delete b[i]
              return done(null)
            }

            var prefix = (
              getPrefix(ch.prefix) || 
              getPrefix(db) || 
              h.prefix || ''
            )
            ch.key = prefix + ch.key
            if(h.test(String(ch.key))) {
              //this usually means a stack overflow.
              return done(new Error('prehook cannot insert into own range'))
            }
            var ke = ch.keyEncoding   || getKeyEncoding(ch.prefix)
            var ve = ch.valueEncoding || getValueEncoding(ch.prefix)
            if(ke) ch.keyEncoding = ke
            if(ve) ch.valueEncoding = ve

            b.push(ch)
            hook(ch, b.length - 1, done)
          },
          put: function (ch, db, done) {
            if('object' === typeof ch) ch.type = 'put'
            this.add(ch, db, done)
          },
          del: function (ch, db) {
            if('object' === typeof ch) ch.type = 'del'
            this.add(ch, db, done)
          },
          veto: function (done) {
            this.add(false, null, done)
          }
        }

        h.hook.call(context, e, context.add, b, doneHook)
      }, doneHooks)
    }, cb)
  }

  function execute(isBatch, b, opts, cb) {
    callHooks(isBatch, b, opts, function (err) {
      if(err) return cb(err)
      b = b.filter(function (e) {
        return e && e.type //filter out empty items
      })

      if(b.length == 1 && !isBatch) {
        var change = b[0]
        return change.type == 'put' 
          ? put.call(db, change.key, change.value, opts, cb) 
          : del.call(db, change.key, opts, cb)  
      }
      return batch.call(db, b, opts, cb)
    })
  }

  db.put = function (key, value, opts, cb ) {
    var batch = [{key: key, value: value, type: 'put'}]
    return execute(false, batch, opts, cb)
  }

  db.del = function (key, opts, cb) {
    var batch = [{key: key, type: 'del'}]
    return execute(false, batch, opts, cb)
  }

  db.batch = function (batch, opts, cb) {
    return execute(true, batch, opts, cb)
  }
}
