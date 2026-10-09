import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';

const appSource = readFileSync('scripts/apps/AppearanceConfigApp.js', 'utf8');
const templateSource = readFileSync('templates/appearance-config.hbs', 'utf8');
const en = JSON.parse(readFileSync('languages/en.json', 'utf8'));
const cn = JSON.parse(readFileSync('languages/cn.json', 'utf8'));

describe('appearance backdrop setting UI', () => {
    it('exposes a table backdrop picker using Foundry imagevideo FilePicker', () => {
        assert.match(templateSource, /data-table-backdrop-path/u);
        assert.match(templateSource, /data-action="pick-table-backdrop"/u);
        assert.match(templateSource, /data-action="clear-table-backdrop"/u);
        assert.match(appSource, /tableBackdropPath/u);
        assert.match(appSource, /type: 'imagevideo'/u);
        assert.match(appSource, /ParlorAppearance\.sanitizeMediaPath/u);
    });

    it('has bilingual backdrop labels under the Foundry cn language code', () => {
        assert.equal(en.PARLOR.Appearance.Fields.TableBackdrop, 'Backdrop file path');
        assert.equal(en.PARLOR.Appearance.Upload.BackdropTitle, 'Table backdrop (image / video)');
        assert.equal(en.PARLOR.Appearance.Upload.PickMedia, 'Choose / Upload');
        assert.equal(cn.PARLOR.Appearance.Fields.TableBackdrop, '背景文件路径');
        assert.equal(cn.PARLOR.Appearance.Upload.BackdropTitle, '桌面背景（图片 / 视频）');
        assert.equal(cn.PARLOR.Appearance.Upload.PickMedia, '选择 / 上传');
    });
});
