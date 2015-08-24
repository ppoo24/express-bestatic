'use strict';

var fs = require('fs');
var path = require('path');
var crypto = require('crypto')
var express = require('express');

module.exports = function (app, options) {
	options = defaults(options || {}, {
		'translator': { //伪静态 与 回源 转换器
			'toNormal': fakeToNormal, //[转换函数]将伪静态URL转成正常URL，参数：url（绝对 或 相对地址）
			'toFake': normalToFake //[转换函数]将正常URL转为伪静态URL，参数：url（绝对 或 相对地址）
		},
		'cache': true, //是否进行缓存
		'cacheDir': '', //缓存目录（绝对路径），必须存在
		'cacheExpire': 86400, //缓存过期时间(秒)
		'cacheRules': null, //缓存规则（正则表达式数组，仅匹配上req.url(是以/打头的)才进行缓存【注：这里的req.url为正常url而非伪静态形式的url】），为空=缓存所有
		'useExpressStatic': '/__VirtualCache' //[后面勿带/]使用express.static来提供数据返回，这里指定虚拟的静态目录URL，可通过此URL访问到指定缓存文件。若留空，则将使用使用流直接输出缓存文件
	});

	var translator = options['translator'];
	var linker = translator.toFake;
	//---配置缓存 及 url转换
	app.use(function (req, res, next) {
		//---将链接转换器植入
		req.linker = linker;

		//---若是伪静态，则改写URL 为 正常URL
		var oldUrl = req.url;
		req.url = req.originalUrl = translator.toNormal(req.url);
		//---重建query
		if (req.url != oldUrl) { req.query = undefined; } //【促使后面重建query】
		
		//---使用缓存
		if (options['cache']) {
			if (options['cacheRules']) {
				var isHit = false;
				for (var i = 0; i < options['cacheRules'].length; i++) { if (options['cacheRules'][i].test(req.url)) { isHit = true; break; } }
				if (!isHit) { return next(); } //未匹配上，无需缓存，直接【回源执行】
			}
			//特征文件名
			var filename = urlToFilename(req.url), //目标缓存文件名
				filepath = path.join(options['cacheDir'], filename); //目标缓存文件地址
			console.log('--------------【缓存文件地址】', filepath);

			//---寻找缓存，若有则直接返回
			fs.stat(filepath, function (err, stats) {
				if (err || (stats.mtime.getTime() + options['cacheExpire']) < Date.now()) { //不存在 或 已过期 或 其他错误，回源
					setCacheRender(res, filepath); //注入render函数进行缓存
					next(); //【回源执行】
				} else if (options['useExpressStatic']) { //重定位到虚拟静态目录
					req.url = req.originalUrl = options['useExpressStatic'] + '/' + filename;
					console.log('-----------------------【重定位静态url】', req.url);
					next(); //到下一步express.static
				} else { //读取缓存返回
					//---流方式读取【注：此次并无容错处理】【后面其实可以直接传递给express的serve-static模块来处理静态页面】
					var stream = fs.createReadStream(filepath, { 'encoding': 'utf-8' });
					stream.pipe(res);
				}
			});
		} else { next(); } //【回源执行】
	});
	//---重建query
	app.use(express.query(app.get('query parser fn')));
	//---配置静态目录
	if (options['useExpressStatic']) { app.use(options['useExpressStatic'], express.static(options['cacheDir'])); }
}; // END - module.exports

///////////////////////

//将伪静态URL转换为正常的回源格式
function fakeToNormal (url) {
	///decoration/tpllist-test1-x1-test2--test3-_xs.html
	//-->
	///decoration/tpllist?test1=x1&test2=&test3
	var matches = (url || '').match(/^([^-]*)(?:-([^\/]*))_xs.html$/);
	if (matches) { //【伪静态】替换 和 缓存
		console.log('----------------【伪静态URL】', url);
		var baseUrl = matches[1] || null,
			params = matches[2] || null;
		if (params) {
			var tmpParts = [];
			params = params.split('-');
			for (var i = 0; i < params.length; i ++) { tmpParts.push(params[i] + '=' + params[++i]); }
			params = tmpParts.join('&');
		}
		return (baseUrl || '') + (params ? '?' + params : '');
	}
	return url;
}
//将回源格式转换为伪静态URL
function normalToFake (url) {
	var retUrl = url;
	///decoration/tpllist/?test1=x1&test2=&test3
	//-->
	///decoration/tpllist/-test1-x1-test2--test3-_xs.html
	var pattern = /^([^\?]*)(?:\?([^\?]*))$/,
		matches = url.match(pattern);
	if (matches) {
		var baseUrl = matches[1] || null,
			params = matches[2] || null;
		if (params) {
			var tmpParts = [];
			params = params.split('&').sort(); //进行一次排序，避免同一种URL生成不同的形式
			for (var i = 0; i < params.length; i ++) {
				var subPart = (params[i] + '').split('=');
				if (subPart[0]) { tmpParts.push(subPart[0] + '-' + (subPart[1] || '')); } //字段名存在时才添加
			}
			params = tmpParts.join('-');
		}
		retUrl = (baseUrl || '') + (params ? '-' + params : '') + '_xs.html';
	}
	return retUrl;
}

//将URL转换为文件名
function urlToFilename (url) {
	return md5(url + '') + '_xs.html';
}

//写入缓存数据到文件
//返回filepath
function cacheToFile (options, fn) {
	options = defaults(options || {}, {
		'filepath': null,
		'data': null
	});
	fs.writeFile(options['filepath'], options.data, function (err) {
		if (err) { return fn(err); }
		fn(null, options['filepath']);
	});
}

//重写res.render以实现写入缓存
function setCacheRender (res, filepath) {
	//---将页面缓存起来【！！！注：若后续程序并未调用res.render，则缓存是无效的】
	//通过重写render实现缓存
	var oldRender = res.render;
	res.render = function (view, subOptions, fn) {
		subOptions = subOptions || {};
		var self = this;
		var req = this.req;
		// support callback function as second arg
		if ('function' == typeof subOptions) {
			fn = subOptions, subOptions = {};
		}
		// default callback to respond
		fn = fn || function(err, str){
			if (err) return req.next(err);
			self.send(str);
		};
		//ws->包装一层返回前先缓存其内容
		var exfn = function (err, str) {
			if (!err) { //若报错，就不缓存了
				cacheToFile({ 'filepath': filepath, 'data': str }, function (err, tmp) { if (err) { console.log('写入缓存文件时失败(' + err.message + ')，请确定缓存目录存在'); } });
			}
			return fn(err, str);
		};
		//<-ws
		//调用原函数
		oldRender.call(res, view, subOptions, exfn);
	};
}

/**
 * ----------------------------------------------------
 * |
 * |通用函数
 * ----------------------------------------------------
 */

//用默认值初始化键值对
function defaults (obj, defs) {
	for (var x in defs) {
		if (typeof obj[x] === 'undefined') {
			obj[x] = defs[x];
		}
	}
	return obj;
}

/**
 * nodejs版MD5
 * @param  {[type]} data   [description]
 * @param  {[type]} digest 返回编码方式：hex[默认]=十六进制，binary=二进制方式，base64=base64编码，buffer=buf对象
 * @return {[type]}        [description]
 */
function md5 (data, digest) {
	if (!digest) { digest = 'hex'; }
	if (digest === 'buffer') { digest = undefined; }
	if (typeof data === 'string') data = new Buffer(data);
	return crypto.createHash('md5').update(data).digest(digest);
}