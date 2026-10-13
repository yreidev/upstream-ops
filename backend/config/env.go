package config

import (
	"os"
	"reflect"
	"strings"
)

// envBindings 单独约定名字的环境变量（APP_SECRET、ADMIN_USERNAME 等不带前缀）。
// 其余配置项也能用环境变量覆盖，名字是路径转大写、点换下划线，比如 SCHEDULER_RATECRON。
var envBindings = map[string]string{
	"security.appSecret": "APP_SECRET",
	"auth.enabled":       "AUTH_ENABLED",
	"auth.username":      "ADMIN_USERNAME",
	"auth.password":      "ADMIN_PASSWORD",
	"auth.tokenSecret":   "AUTH_TOKEN_SECRET",
	"database.path":      "DATABASE_PATH",
	"server.port":        "SERVER_PORT",
	"server.mode":        "SERVER_MODE",
	"log.level":          "LOG_LEVEL",
}

// KeyPaths 列出 Config 里所有叶子配置项的路径，按 mapstructure 标签拼，比如 scheduler.retention.cron。
func KeyPaths() []string {
	var out []string
	var walk func(t reflect.Type, prefix string)
	walk = func(t reflect.Type, prefix string) {
		for i := 0; i < t.NumField(); i++ {
			f := t.Field(i)
			name := f.Tag.Get("mapstructure")
			if name == "" || name == "-" {
				continue
			}
			path := prefix + name
			if f.Type.Kind() == reflect.Struct {
				walk(f.Type, path+".")
				continue
			}
			out = append(out, path)
		}
	}
	walk(reflect.TypeOf(Config{}), "")
	return out
}

// EnvOverrides 列出当前进程里设置了、会盖过配置文件的环境变量：配置项路径 → 环境变量名。
// 和 Load 的规则一致：空值不算（Viper 默认不认空环境变量）。
func EnvOverrides(keys []string) map[string]string {
	out := map[string]string{}
	for _, key := range keys {
		names := []string{strings.ToUpper(strings.ReplaceAll(key, ".", "_"))}
		if bound, ok := envBindings[key]; ok && bound != names[0] {
			names = append(names, bound)
		}
		for _, name := range names {
			if v, ok := os.LookupEnv(name); ok && v != "" {
				out[key] = name
				break
			}
		}
	}
	return out
}

// CopyKeys 把 src 里这些路径的值抄到 dst；不认识的路径跳过。
func CopyKeys(dst, src *Config, keys []string) {
	for _, key := range keys {
		to, from := fieldByPath(reflect.ValueOf(dst).Elem(), key), fieldByPath(reflect.ValueOf(src).Elem(), key)
		if to.IsValid() && from.IsValid() && to.CanSet() {
			to.Set(from)
		}
	}
}

func fieldByPath(v reflect.Value, path string) reflect.Value {
	for _, name := range strings.Split(path, ".") {
		if v.Kind() != reflect.Struct {
			return reflect.Value{}
		}
		next := reflect.Value{}
		for i := 0; i < v.NumField(); i++ {
			if v.Type().Field(i).Tag.Get("mapstructure") == name {
				next = v.Field(i)
				break
			}
		}
		if !next.IsValid() {
			return next
		}
		v = next
	}
	return v
}
